import { randomUUID } from 'node:crypto';
import { open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkPilotBackup, type CheckedPilotBackup } from './pilot-backup-contract.ts';
import { readPrivateFile } from './event-restore.ts';
import { privateDirectory } from './scheduled-backup.ts';

export type PilotRestoreOptions = {
  directory: string;
  id: string;
  silo: string;
  images: Record<string, string>;
  stateDirectory: string;
};

export type PilotRestoreTarget = {
  acquire(): Promise<() => Promise<void>>;
  identity(): Promise<Record<string, string>>;
  requireIsolated(): Promise<void>;
  hold(): Promise<void>;
  empty(): Promise<boolean>;
  events(backup: CheckedPilotBackup, resume?: boolean): Promise<void>;
  database(backup: CheckedPilotBackup): Promise<void>;
  files(backup: CheckedPilotBackup): Promise<void>;
  verify(backup: CheckedPilotBackup): Promise<void>;
  open(backup: CheckedPilotBackup): Promise<void>;
};

const stages = ['events', 'database', 'files', 'verify', 'open', 'complete'] as const;
const journalSchema = z.object({
  version: z.literal(1), backupId: z.string(), manifestDigest: z.string(),
  target: z.record(z.string(), z.string().min(1)), stage: z.enum(stages),
  eventsStarted: z.boolean(),
}).strict();
type Journal = z.infer<typeof journalSchema>;
export type PilotRestoreReason = 'invalid_backup' | 'non_empty' | 'target_changed'
  | 'concurrent' | 'stage_failed';

export class PilotRestoreRefused extends Error {
  readonly reason: PilotRestoreReason;
  readonly stage: string;

  constructor(reason: PilotRestoreReason, stage: string, cause?: unknown) {
    super('Pilot restore refused; keep the installation isolated', { cause });
    this.reason = reason;
    this.stage = stage;
  }
}

function savedJournal(directory: string): Journal | undefined {
  try {
    const bytes = readPrivateFile(join(directory, 'journal.json'), 1024 * 1024);
    return journalSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function saveJournal(directory: string, journal: Journal) {
  const temporary = join(directory, `.journal-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, join(directory, 'journal.json'));
  const folder = await open(directory, 'r');
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

async function restorationJournal(options: PilotRestoreOptions,
  backup: CheckedPilotBackup, target: PilotRestoreTarget) {
  const identity = await target.identity();
  const saved = savedJournal(options.stateDirectory);
  if (saved) {
    if (saved.backupId !== backup.manifest.id || saved.manifestDigest !== backup.manifestDigest ||
        !isDeepStrictEqual(saved.target, identity)) {
      throw new PilotRestoreRefused('target_changed', 'journal');
    }
    return saved;
  }
  if (!await target.empty()) throw new PilotRestoreRefused('non_empty', 'empty');
  await target.requireIsolated();
  const journal: Journal = { version: 1, backupId: backup.manifest.id,
    manifestDigest: backup.manifestDigest, target: identity, stage: 'events', eventsStarted: false };
  await saveJournal(options.stateDirectory, journal);
  return journal;
}

async function restoreStages(options: PilotRestoreOptions, backup: CheckedPilotBackup,
  target: PilotRestoreTarget, journal: Journal) {
  if (journal.stage === 'complete' || journal.stage === 'open') await target.hold();
  for (const stage of ['events', 'database', 'files'] as const) {
    if (stages.indexOf(stage) < stages.indexOf(journal.stage)) continue;
    await checkTargetIdentity(target, journal);
    await target.requireIsolated();
    if (stage === 'events') {
      const resume = journal.eventsStarted;
      journal.eventsStarted = true;
      await saveJournal(options.stateDirectory, journal);
      await target.events(backup, resume);
    } else {
      await target[stage](backup);
    }
    const index = stages.indexOf(stage);
    journal.stage = stages[index + 1]!;
    await saveJournal(options.stateDirectory, journal);
  }
  await target.requireIsolated();
  await target.verify(backup);
  await checkTargetIdentity(target, journal);
  journal.stage = 'open';
  await saveJournal(options.stateDirectory, journal);
  await target.open(backup);
  journal.stage = 'complete';
  await saveJournal(options.stateDirectory, journal);
}

async function checkTargetIdentity(target: PilotRestoreTarget, journal: Journal) {
  if (!isDeepStrictEqual(await target.identity(), journal.target)) {
    throw new PilotRestoreRefused('target_changed', journal.stage);
  }
}

export async function restorePilotBackup(options: PilotRestoreOptions,
  target: PilotRestoreTarget) {
  let stage = 'backup';
  let release: (() => Promise<void>) | undefined;
  let journal: Journal | undefined;
  try {
    const backup = await checkPilotBackup(options);
    await privateDirectory(options.stateDirectory);
    stage = 'lock';
    release = await target.acquire();
    stage = 'journal';
    journal = await restorationJournal(options, backup, target);
    stage = journal.stage;
    await restoreStages(options, backup, target, journal);
    return { status: 'complete' as const, backupId: backup.manifest.id,
      sequence: backup.manifest.point.sequence };
  } catch (cause) {
    stage = journal?.stage ?? stage;
    if (cause instanceof PilotRestoreRefused) throw cause;
    let reason: PilotRestoreReason = 'stage_failed';
    if (stage === 'backup') reason = 'invalid_backup';
    if (stage === 'lock') reason = 'concurrent';
    throw new PilotRestoreRefused(reason, stage, cause);
  } finally {
    await release?.();
  }
}
