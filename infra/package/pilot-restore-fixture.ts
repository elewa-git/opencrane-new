import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { hashBackupBytes } from './backup-bytes.ts';
import { captureScheduledBackup } from './scheduled-backup.ts';
import { pilotProjectionNames } from './pilot-projections.ts';
import { z } from 'zod';
import { collectEventBackup } from './event-backup.ts';
import { captureMemberKeys, type MemberKeyDirectories } from './pilot-member-keys.ts';

type CapturedKeys = { sequence: number; directories: MemberKeyDirectories };

export async function pilotBackupFixture(eventSource?: Parameters<typeof collectEventBackup>[0],
  capturedKeys?: CapturedKeys) {
  const directory = await mkdtemp('/tmp/pilot-restore-');
  onTestFinished(clean);
  async function clean() { await rm(directory, { recursive: true, force: true }); }
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const images: Record<string, string> = {};
  for (const name of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer',
    'objects', 'scanner']) {
    images[name] = `registry.example.test/${name}@sha256:${'a'.repeat(64)}`;
  }
  const sequence = capturedKeys?.sequence ?? 1;
  const checkpoints: Record<string, number> = { dispatcher: sequence, memory: sequence };
  for (const name of pilotProjectionNames()) checkpoints[name] = sequence;
  const point = { sequence, lsn: '0/1', checkpoints };
  const backupKeyFile = join(directory, '.fixture-key');
  await writeFile(backupKeyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  const keyDirectories = { personal: join(directory, 'personal'), memory: join(directory, 'memory') };
  await mkdir(keyDirectories.personal, { mode: 0o700 });
  await mkdir(keyDirectories.memory, { mode: 0o700 });
  const options = { directory, stateDirectory, id: 'pilot-backup', silo: 'dev', images,
    backupKeyFile, keyDirectories };
  function pause() { return Promise.resolve(point); }
  function resume() { return Promise.resolve(); }
  async function events(destination: string) {
    if (eventSource) {
      const capture = `${destination}-capture`;
      await collectEventBackup(eventSource, { silo: 'dev', attempt: options.id,
        destination: capture });
      const contents = await readFile(join(capture, 'descriptor.json'), 'utf8');
      const descriptor = z.record(z.string(), z.json()).parse(JSON.parse(contents));
      await copyFile(join(capture, 'events.snapshot'), destination);
      await rm(capture, { recursive: true, force: true });
      return descriptor;
    }
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
  async function memberKeys(destination: string) {
    const identity = { id: options.id, silo: options.silo, sequence: point.sequence };
    const sourceDirectories = capturedKeys?.directories ?? keyDirectories;
    return captureMemberKeys(destination, identity, backupKeyFile, sourceDirectories);
  }
  const parts = { events, database, files: uploadedFiles, 'member-keys': memberKeys };
  const source = { pause, verify: pause, resume, parts };
  await captureScheduledBackup(options, source);
  return options;
}
