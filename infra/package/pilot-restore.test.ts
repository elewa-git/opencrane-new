import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { members, mcpCatalogue, computers, conversations, files, auditTrail,
  personalSettings, groups, providers, modelAccess, egressPolicy, connectionProfiles,
  childRequests } from '@opencrane/projections';
import { budgets } from '@opencrane/models';
import { hashBackupBytes } from './backup-bytes.ts';
import { captureScheduledBackup, manifestSchema } from './scheduled-backup.ts';
import { restorePilotBackup, PilotRestoreRefused, type PilotRestoreTarget } from './pilot-restore.ts';

const directories: string[] = [];
afterEach(async function clean() {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function backupFixture() {
  const directory = await mkdtemp('/tmp/pilot-restore-');
  directories.push(directory);
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const images: Record<string, string> = {};
  for (const name of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer',
    'objects', 'scanner']) {
    images[name] = `registry.example.test/${name}@sha256:${'a'.repeat(64)}`;
  }
  const checkpoints: Record<string, number> = { dispatcher: 1 };
  for (const projection of [members, mcpCatalogue, computers, conversations, files,
    budgets, auditTrail, personalSettings, groups, providers, modelAccess, egressPolicy,
    connectionProfiles, childRequests]) {
    checkpoints[projection.name] = 1;
  }
  const point = { sequence: 1, lsn: '0/1', checkpoints };
  const options = { directory, stateDirectory, id: 'pilot-backup', silo: 'dev', images };
  async function pause() { return point; }
  async function resume() {}
  async function events(destination: string) {
    const bytes = Buffer.from('snapshot');
    await writeFile(destination, bytes, { mode: 0o600 });
    return { version: 1, kind: 'event-bytes-only', silo: 'dev', attempt: options.id,
      created: '2026-11-17T00:00:00Z', firstSequence: 1, lastSequence: 1, eventCount: 1,
      config: { name: 'EVENTS', subjects: ['ev.>'], storage: 'file', retention: 'limits',
        num_replicas: 1, discard: 'old' },
      subjectPositions: { 'member-alice': 1 }, identityDigest: 'b'.repeat(64),
      byteCount: bytes.length, sha256: hashBackupBytes(bytes) };
  }
  async function database(destination: string) {
    await writeFile(destination, '-- a stopped database dump', { mode: 0o600 });
    return { databases: ['handlers', 'openfga', 'postgres', 'projections'], lsn: '0/1',
      access: { storeId: 'saved-store', modelId: 'saved-model' } };
  }
  async function uploadedFiles(destination: string) {
    await writeFile(destination, '', { mode: 0o600 });
    return { bucket: 'files', objects: [] };
  }
  const parts = { events, database, files: uploadedFiles };
  const source = { pause, verify: pause, resume, parts };
  await captureScheduledBackup(options, source);
  return options;
}

function emptyTarget() {
  const stages: string[] = [];
  let admitted = false;
  let locked = false;
  async function release() { locked = false; }
  async function acquire() {
    if (locked) throw new PilotRestoreRefused('concurrent', 'lock');
    locked = true;
    return release;
  }
  async function identity() { return { namespace: 'fresh-namespace', nats: 'fresh-volume' }; }
  async function requireIsolated() { expect(admitted).toBe(false); }
  async function hold() { admitted = false; }
  async function empty() { return true; }
  function record(stage: string) {
    if (!stages.includes(stage)) stages.push(stage);
  }
  async function events() { record('events'); }
  async function database() { record('database'); }
  async function files() { record('files'); }
  async function verify() { record('verify'); }
  async function open() {
    expect(stages.slice(0, 4)).toEqual(['events', 'database', 'files', 'verify']);
    record('open');
    admitted = true;
  }
  const target: PilotRestoreTarget = { acquire, identity, requireIsolated, hold, empty,
    events, database, files, verify, open };
  return { target, stages, admitted: () => admitted };
}

async function restoresAnEmptyInstallationBeforeAdmission() {
  const options = await backupFixture();
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).resolves.toMatchObject({
    status: 'complete', backupId: options.id, sequence: 1,
  });
  expect(runtime.stages).toEqual(['events', 'database', 'files', 'verify', 'open']);
  expect(runtime.admitted()).toBe(true);
}
it('restores all three parts into an empty installation before opening reading',
  restoresAnEmptyInstallationBeforeAdmission);

async function refusesAnUnboundAccessStore() {
  const options = await backupFixture();
  const path = join(options.directory, options.id, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  delete manifest.parts.database.details['access'];
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'invalid_backup',
  });
  expect(runtime.stages).toEqual([]);
}
it('refuses an unbound access store before changing the target', refusesAnUnboundAccessStore);

async function refusesNonEmptyTarget() {
  const options = await backupFixture();
  const runtime = emptyTarget();
  async function nonEmpty() { return false; }
  runtime.target.empty = nonEmpty;
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'non_empty',
  });
  expect(runtime.stages).toEqual([]);
}
it('refuses a non-empty target without restoring any part', refusesNonEmptyTarget);

async function refusesInvalidSet(kind: string) {
  const options = await backupFixture();
  const path = join(options.directory, options.id, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (kind === 'mixed') manifest.parts.events.backupId = 'another-backup';
  if (kind === 'version') manifest.images['server'] = `registry.example.test/server@sha256:${'c'.repeat(64)}`;
  if (kind === 'point') manifest.parts.events.details['lastSequence'] = 2;
  if (kind === 'ahead') manifest.point.checkpoints['members'] = 2;
  if (kind === 'missing checkpoint') delete manifest.point.checkpoints['members'];
  if (kind === 'dates') manifest.stoppedAt = '2000-01-01T00:00:00Z';
  if (kind === 'tampered') {
    await writeFile(join(options.directory, options.id, 'events'), 'changed bytes');
  }
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'invalid_backup',
  });
  expect(runtime.stages).toEqual([]);
}
it.each(['mixed', 'version', 'point', 'ahead', 'missing checkpoint', 'dates', 'tampered'])(
  'refuses %s evidence before restoring anything', refusesInvalidSet);

async function resumesEachStage(stage: 'events' | 'database' | 'files' | 'verify' | 'open') {
  const options = await backupFixture();
  const runtime = emptyTarget();
  const original = runtime.target[stage];
  async function interrupted(backup: Parameters<typeof original>[0]) {
    await original(backup);
    throw new Error('Simulated crash after the operation');
  }
  runtime.target[stage] = interrupted;
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'stage_failed', stage,
  });
  if (stage !== 'open') expect(runtime.admitted()).toBe(false);
  runtime.target[stage] = original;
  await expect(restorePilotBackup(options, runtime.target)).resolves.toMatchObject({
    status: 'complete', sequence: 1,
  });
  expect(runtime.stages).toEqual(['events', 'database', 'files', 'verify', 'open']);
}
it.each(['events', 'database', 'files', 'verify', 'open'] as const)(
  'resumes the same set after interruption at %s', resumesEachStage);

async function acceptsCheckedRerun() {
  const options = await backupFixture();
  const runtime = emptyTarget();
  const result = await restorePilotBackup(options, runtime.target);
  async function mustNotReset() { throw new Error('Must not reset restored state'); }
  runtime.target.events = mustNotReset;
  runtime.target.database = mustNotReset;
  runtime.target.files = mustNotReset;
  expect(await restorePilotBackup(options, runtime.target)).toEqual(result);
}
it('verifies a completed same-set rerun without restoring over it', acceptsCheckedRerun);

async function refusesChangedTarget() {
  const options = await backupFixture();
  const runtime = emptyTarget();
  await restorePilotBackup(options, runtime.target);
  async function replacedVolume() { return { namespace: 'fresh-namespace', nats: 'foreign-volume' }; }
  runtime.target.identity = replacedVolume;
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'target_changed',
  });
}
it('refuses a journal belonging to replaced target storage', refusesChangedTarget);

async function refusesConcurrentRunner() {
  const options = await backupFixture();
  const runtime = emptyTarget();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events = runtime.target.events;
  async function held(backup: Parameters<typeof events>[0]) {
    started.resolve();
    await release.promise;
    await events(backup);
  }
  runtime.target.events = held;
  const first = restorePilotBackup(options, runtime.target);
  await started.promise;
  try {
    await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
      reason: 'concurrent',
    });
  } finally {
    release.resolve();
    await first;
  }
}
it('refuses a concurrent runner while the first restore owns the target', refusesConcurrentRunner);

async function refusesInvalidFiles(kind: string) {
  const options = await backupFixture();
  const path = join(options.directory, options.id, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const bytes = Buffer.from('A saved file');
  const entry = { key: 'saved-file', byteCount: bytes.length, sha256: hashBackupBytes(bytes) };
  const objects = [entry];
  let data = bytes.toString('base64');
  if (kind === 'duplicate') objects.push(entry);
  if (kind === 'corrupt') data = Buffer.from('A wrong file').toString('base64');
  const archived = Buffer.from(JSON.stringify({ ...entry, data }));
  manifest.parts.files.details = { bucket: 'files', objects };
  manifest.parts.files.byteCount = archived.length;
  manifest.parts.files.sha256 = hashBackupBytes(archived);
  await writeFile(join(options.directory, options.id, 'files'), archived);
  await writeFile(path, JSON.stringify(manifest));
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'invalid_backup',
  });
  expect(runtime.stages).toEqual([]);
}
it.each(['duplicate', 'corrupt'])('refuses %s file bytes before changing the target',
  refusesInvalidFiles);

async function remembersANativeAttemptAcrossCrashes() {
  const options = await backupFixture();
  const runtime = emptyTarget();
  const attempts: boolean[] = [];
  const events = runtime.target.events;
  async function interrupted(backup: Parameters<typeof events>[0], resume = false) {
    attempts.push(resume);
    await events(backup);
    if (attempts.length === 1) throw new Error('Simulated interrupted native attempt');
  }
  runtime.target.events = interrupted;
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({ stage: 'events' });
  await restorePilotBackup(options, runtime.target);
  expect(attempts).toEqual([false, true]);
}
it('journals the native attempt before transfer so crashes cannot trigger a blind resend',
  remembersANativeAttemptAcrossCrashes);
