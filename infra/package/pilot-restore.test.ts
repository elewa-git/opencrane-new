import { pilotBackupFixture } from './pilot-restore-fixture.ts';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hashBackupBytes } from './backup-bytes.ts';
import { manifestSchema } from './scheduled-backup.ts';
import { restorePilotBackup, PilotRestoreRefused, type PilotRestoreTarget } from './pilot-restore.ts';


function emptyTarget() {
  const stages: string[] = [];
  let admitted = false;
  let locked = false;
  function release() {
    locked = false;
    return Promise.resolve();
  }
  function acquire() {
    if (locked) return Promise.reject(new PilotRestoreRefused('concurrent', 'lock'));
    locked = true;
    return Promise.resolve(release);
  }
  function identity() {
    return Promise.resolve({ namespace: 'fresh-namespace', nats: 'fresh-volume' });
  }
  function requireIsolated() {
    expect(admitted).toBe(false);
    return Promise.resolve();
  }
  function hold() {
    admitted = false;
    return Promise.resolve();
  }
  function empty() { return Promise.resolve(true); }
  function record(stage: string) {
    if (!stages.includes(stage)) stages.push(stage);
  }
  function keys() {
    record('keys');
    return Promise.resolve();
  }
  function events() {
    record('events');
    return Promise.resolve();
  }
  function database() {
    record('database');
    return Promise.resolve();
  }
  function files() {
    record('files');
    return Promise.resolve();
  }
  function verify() {
    record('verify');
    return Promise.resolve();
  }
  function open() {
    expect(stages.slice(0, 5)).toEqual(['keys', 'events', 'database', 'files', 'verify']);
    record('open');
    admitted = true;
    return Promise.resolve();
  }
  const target: PilotRestoreTarget = { acquire, identity, requireIsolated, hold, empty,
    keys, events, database, files, verify, open };
  return { target, stages, admitted: () => admitted };
}

async function restoresAnEmptyInstallationBeforeAdmission() {
  const options = await pilotBackupFixture();
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).resolves.toMatchObject({
    status: 'complete', backupId: options.id, sequence: 1,
  });
  expect(runtime.stages).toEqual(['keys', 'events', 'database', 'files', 'verify', 'open']);
  expect(runtime.admitted()).toBe(true);
}
it('restores all four parts into an empty installation before opening reading',
  restoresAnEmptyInstallationBeforeAdmission);

async function refusesWithoutMemberKeys() {
  const options = await pilotBackupFixture();
  const directory = join(options.directory, options.id);
  const path = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { parts: Record<string, unknown> };
  delete manifest.parts['member-keys'];
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  await rm(join(directory, 'member-keys'), { force: true });
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'member_keys_unavailable', stage: 'backup',
  });
  expect(runtime.stages).toEqual([]);
  expect(runtime.admitted()).toBe(false);
}
it('refuses a backup without member keys before restoring any data', refusesWithoutMemberKeys);

async function refusesMissingKeyFile(missing: 'encrypted part' | 'encryption key') {
  const options = await pilotBackupFixture();
  const file = missing === 'encrypted part'
    ? join(options.directory, options.id, 'member-keys') : options.backupKeyFile;
  await rm(file);
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'member_keys_unavailable', stage: 'backup',
  });
  expect(runtime.stages).toEqual([]);
  expect(runtime.admitted()).toBe(false);
}
it.each(['encrypted part', 'encryption key'] as const)(
  'refuses without the %s before restoring any data', refusesMissingKeyFile);

async function restoresProviderCheckpointInventory() {
  const options = await pilotBackupFixture();
  const path = join(options.directory, options.id, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  manifest.point.checkpoints['routines'] = manifest.point.sequence;
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  const runtime = emptyTarget();
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'invalid_backup', stage: 'backup',
  });
  expect(runtime.stages).toEqual([]);
  const providerOptions = { ...options, providerMode: true };
  await expect(restorePilotBackup(providerOptions, runtime.target)).resolves.toMatchObject({
    status: 'complete', backupId: options.id, sequence: manifest.point.sequence,
  });
  expect(runtime.admitted()).toBe(true);
}
it('restores the provider backup only when the matching routines projection is selected',
  restoresProviderCheckpointInventory);

async function refusesAnUnboundAccessStore() {
  const options = await pilotBackupFixture();
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
  const options = await pilotBackupFixture();
  const runtime = emptyTarget();
  function nonEmpty() { return Promise.resolve(false); }
  runtime.target.empty = nonEmpty;
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'non_empty',
  });
  expect(runtime.stages).toEqual([]);
}
it('refuses a non-empty target without restoring any part', refusesNonEmptyTarget);

async function refusesInvalidSet(kind: string) {
  const options = await pilotBackupFixture();
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

async function resumesEachStage(stage: 'keys' | 'events' | 'database' | 'files' | 'verify' | 'open') {
  const options = await pilotBackupFixture();
  const runtime = emptyTarget();
  const original = runtime.target[stage].bind(runtime.target);
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
  expect(runtime.stages).toEqual(['keys', 'events', 'database', 'files', 'verify', 'open']);
}
it.each(['keys', 'events', 'database', 'files', 'verify', 'open'] as const)(
  'resumes the same set after interruption at %s', resumesEachStage);

async function acceptsCheckedRerun() {
  const options = await pilotBackupFixture();
  const runtime = emptyTarget();
  const result = await restorePilotBackup(options, runtime.target);
  function mustNotReset(): Promise<void> {
    return Promise.reject(new Error('Must not reset restored state'));
  }
  runtime.target.events = mustNotReset;
  runtime.target.database = mustNotReset;
  runtime.target.files = mustNotReset;
  expect(await restorePilotBackup(options, runtime.target)).toEqual(result);
}
it('verifies a completed same-set rerun without restoring over it', acceptsCheckedRerun);

async function refusesChangedTarget() {
  const options = await pilotBackupFixture();
  const runtime = emptyTarget();
  await restorePilotBackup(options, runtime.target);
  function replacedVolume() {
    return Promise.resolve({ namespace: 'fresh-namespace', nats: 'foreign-volume' });
  }
  runtime.target.identity = replacedVolume;
  await expect(restorePilotBackup(options, runtime.target)).rejects.toMatchObject({
    reason: 'target_changed',
  });
}
it('refuses a journal belonging to replaced target storage', refusesChangedTarget);

async function refusesConcurrentRunner() {
  const options = await pilotBackupFixture();
  const runtime = emptyTarget();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events = runtime.target.events.bind(runtime.target);
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
  const options = await pilotBackupFixture();
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
  const options = await pilotBackupFixture();
  const runtime = emptyTarget();
  const attempts: boolean[] = [];
  const events = runtime.target.events.bind(runtime.target);
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
