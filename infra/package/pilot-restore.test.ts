import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { members, mcpCatalogue, computers, conversations, files, auditTrail,
  personalSettings, groups, providers, modelAccess, egressPolicy, connectionProfiles,
  childRequests } from '@opencrane/projections';
import { budgets } from '@opencrane/models';
import { hashBackupBytes } from './backup-bytes.ts';
import { captureScheduledBackup } from './scheduled-backup.ts';
import { restorePilotBackup, type PilotRestoreTarget } from './pilot-restore.ts';

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
    return { databases: ['handlers', 'openfga', 'postgres', 'projections'], lsn: '0/1' };
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
  async function release() {}
  async function acquire() { return release; }
  async function identity() { return { namespace: 'fresh-namespace', nats: 'fresh-volume' }; }
  async function requireIsolated() { expect(admitted).toBe(false); }
  async function empty() { return true; }
  async function events() { stages.push('events'); }
  async function database() { stages.push('database'); }
  async function files() { stages.push('files'); }
  async function verify() { stages.push('verify'); }
  async function open() {
    expect(stages).toEqual(['events', 'database', 'files', 'verify']);
    stages.push('open');
    admitted = true;
  }
  const target: PilotRestoreTarget = { acquire, identity, requireIsolated, empty,
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
