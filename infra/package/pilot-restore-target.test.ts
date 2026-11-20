import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fileUploadedDataSchema } from '@opencrane/events';
import { envelope } from '@opencrane/models';
import { restoreTargetFixture } from './pilot-restore-target-fixture.ts';
import { packageRestoreTarget } from './pilot-restore-target.ts';
import { restorePilotBackup } from './pilot-restore.ts';
import { checkPilotBackup } from './pilot-backup-contract.ts';
import { pilotBackupFixture } from './pilot-restore-fixture.ts';
import { hashBackupBytes } from './backup-bytes.ts';
import { natsFixture } from '@opencrane/event-store/testing';

vi.mock('./pilot-restore-kube.ts', function kubernetesBoundary() {
  return { restoreKube: kube };
});
vi.mock('./pilot-storage.ts', function objectBoundary() {
  return { pilotStorage: storage };
});
let fixture: Awaited<ReturnType<typeof restoreTargetFixture>>;
let runtime: Awaited<ReturnType<typeof packageRestoreTarget>>;
async function kube(args: string[]) { return fixture.kube(args); }
async function storage() { return fixture.storage(); }
async function setup() {
  fixture = await restoreTargetFixture();
  for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
  runtime = await packageRestoreTarget(fixture.options);
  expect(await runtime.target.empty()).toBe(true);
}
async function cleanup() {
  await runtime?.close();
  await fixture?.close();
  vi.unstubAllEnvs();
}
beforeEach(setup);
afterEach(cleanup);

async function unchanged(before: Awaited<ReturnType<typeof fixture.snapshot>>) {
  await runtime.close();
  await fixture.content.reopen();
  runtime = await packageRestoreTarget(fixture.options);
  expect(await fixture.snapshot()).toEqual(before);
  expect((await fixture.state()).opened).toBe(false);
}
async function refusesNonEmpty(kind: string) {
  await fixture.nonEmpty(kind);
  const before = await fixture.snapshot();
  await expect(restorePilotBackup(fixture.options, runtime.target)).rejects.toMatchObject({
    reason: 'non_empty', stage: 'empty',
  });
  await unchanged(before);
  await expect(readFile(join(fixture.options.stateDirectory, 'journal.json')))
    .rejects.toMatchObject({ code: 'ENOENT' });
}
it.each(['event stream', 'database', 'role', 'table', 'object'])(
  'production restore refuses an existing %s and preserves durable state', refusesNonEmpty);

async function refusesActiveWriter(kind: string) {
  if (kind === 'deployment') await fixture.change({ writer: 'worker-dispatcher' });
  if (kind === 'pod') await fixture.change({ pod: 'worker-dispatcher' });
  if (kind === 'read-only') await fixture.change({ readOnly: false });
  if (kind === 'reader identity') await fixture.change({ reader: false });
  if (kind === 'models') await fixture.change({ models: true });
  const before = await fixture.snapshot();
  await expect(restorePilotBackup(fixture.options, runtime.target)).rejects.toMatchObject({
    reason: 'stage_failed', stage: 'journal',
  });
  await unchanged(before);
}
it.each(['deployment', 'pod', 'read-only', 'reader identity', 'models'])(
  'production restore keeps admission closed with an active %s', refusesActiveWriter);

async function refusesBetweenStages(kind: string) {
  const source = await natsFixture();
  try {
    const event = envelope('dev', 'member-alice', 'member.joined', {
      memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'owner',
    });
    await source.seed([event]);
    const options = await pilotBackupFixture(source.connection);
    let afterImport: Awaited<ReturnType<typeof fixture.snapshot>> | undefined;
    async function changed() {
      const snapshot = await fixture.snapshot();
      const position = z.object({ last_seq: z.literal(1) }).safeParse(snapshot.events.state);
      if (!position.success) return;
      afterImport ??= await fixture.snapshot();
      if (kind === 'identity') await fixture.change({ account: 'replaced-account' });
      if (kind === 'writer') await fixture.change({ pod: 'worker-dispatcher' });
    }
    fixture.onIdentity(changed);
    fixture.onIsolation(changed);
    // Keep a broken guard from reaching database reset on the shared test server.
    // Every identity, isolation and native import operation above is the production operation.
    function forbiddenDatabase(): Promise<void> {
      return Promise.reject(new Error('Database must remain untouched'));
    }
    runtime.target.database = forbiddenDatabase;
    const reason = kind === 'identity' ? 'target_changed' : 'stage_failed';
    const cause = kind === 'writer' ? { message: 'Restore writers remain' } : undefined;
    await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
      reason, stage: 'database', ...(cause ? { cause } : {}),
    });
    expect(afterImport).toBeDefined();
    await unchanged(afterImport!);
    const journalBytes = await readFile(join(options.stateDirectory, 'journal.json'), 'utf8');
    const journal = z.object({ stage: z.string(), eventsStarted: z.boolean() })
      .parse(JSON.parse(journalBytes));
    expect(journal).toMatchObject({ stage: 'database', eventsStarted: true });
    expect(await fixture.nats.store.head()).toBe(1);
  } finally {
    await source.close();
  }
}
it.each(['identity', 'writer'])(
  'production restore refuses a changed %s between stages and retains native import',
  refusesBetweenStages);

async function fileFixture() {
  await fixture.content.db.query('CREATE TABLE conversation_files (silo TEXT, data JSONB)');
  const bytes = Buffer.from('original object');
  const data = fileUploadedDataSchema.parse({ conversationId: 'chat', fileId: 'file',
    name: 'report.pdf', mime: 'application/pdf', size: bytes.length,
    sha256: hashBackupBytes(bytes), objectKey: 'saved', uploadedBy: 'alice' });
  await fixture.content.db.query('INSERT INTO conversation_files VALUES ($1,$2)',
    ['dev', JSON.stringify(data)]);
  const backup = await checkPilotBackup(fixture.options);
  backup.files.objects = [{ key: 'saved', byteCount: bytes.length, sha256: hashBackupBytes(bytes) }];
  backup.objects.set('saved', bytes);
  return { backup, bytes };
}
async function refusesChangedObject() {
  const { backup } = await fileFixture();
  await writeFile(join(fixture.objectDirectory, 'saved'), 'modified object');
  const before = await fixture.snapshot();
  await expect(runtime.target.files(backup)).rejects.toThrow('Stored object checksum differs');
  await unchanged(before);
}
it('production file restore refuses equal-length changed bytes without replacing them',
  refusesChangedObject);

async function refusesForeignFileReference() {
  const { backup } = await fileFixture();
  backup.files.objects[0]!.sha256 = 'b'.repeat(64);
  const before = await fixture.snapshot();
  await expect(runtime.target.files(backup)).rejects.toThrow('File differs from events');
  await unchanged(before);
}
it('production file restore refuses a reference that differs from the saved event',
  refusesForeignFileReference);

async function refusesCorruptedReadback() {
  const { backup, bytes } = await fileFixture();
  const before = await fixture.snapshot();
  fixture.corruptObjectWrites();
  await expect(runtime.target.files(backup)).rejects.toThrow('Stored object checksum differs');
  const corrupted = Buffer.from(bytes);
  corrupted[0] = corrupted[0]! ^ 1;
  const expected = { ...before, objects: { saved: corrupted.toString('base64') } };
  await unchanged(expected);
}
it('production file restore reads uploaded bytes back before allowing admission',
  refusesCorruptedReadback);
