import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, onTestFinished, vi } from 'vitest';
import { envelope } from '@opencrane/models';
import { natsFixture } from '@opencrane/event-store/testing';
import { conversations, files, members, ProjectionRunner, type Db } from '@opencrane/projections';
import { rebuildMembers } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { fixture, logger } from '../../libs/handlers/test/helpers.ts';
import { restoreStorage } from '../../apps/server/test/support/restore-storage.ts';
import { collectObjectBackup } from './object-backup.ts';
import { restoreRecoveryBackup } from './recovery-restore.ts';
import { recoveryCustody } from './upgrade-recovery-custody-fixture.ts';
import { descriptorSchema } from './event-backup.ts';
import { provisionDisposableObjectTarget } from './disposable-object-target.ts';
import { collectFileRecovery, checkFileRecovery } from './upgrade-recovery-files.ts';
import { recoveryEffectProbes } from './upgrade-recovery-files-effects.ts';
import { checkRecoveryReads, seedRecoveryReader } from './upgrade-recovery-files-reads.ts';

type Nats = Pick<Awaited<ReturnType<typeof natsFixture>>,
  'connection' | 'store' | 'reader' | 'seed'>;
type Storage = Awaited<ReturnType<typeof restoreStorage>>['client'];

export async function seedRecoveryFiles(nats: Nats, objects: Storage) {
  await objects.makeBucket('files');
  const uploads = [];
  for (const fileId of ['notes', 'screen']) {
    let bytes = Buffer.from('Synthetic recovery notes');
    let name = 'notes.txt';
    let mime = 'text/plain';
    if (fileId === 'screen') {
      bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lE' +
        'QVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
      name = 'screen.png';
      mime = 'image/png';
    }
    const hash = createHash('sha256');
    hash.update(bytes);
    const sha256 = hash.digest('hex');
    const screenshot = { computerId: 'computer', generation: 1,
      capturedAt: '2026-10-26T12:00:00.000Z', width: 1, height: 1 };
    const data = { conversationId: 'file-chat', fileId, uploadedBy: 'reader',
      name, mime, size: bytes.length, sha256,
      objectKey: `test/file-chat/${fileId}/${sha256}`,
      ...(fileId === 'screen' ? { screenshot } : {}) };
    await objects.putObject('files', data.objectKey, bytes);
    const uploaded = envelope('test', 'conversation-file-chat', 'file.uploaded', data);
    await nats.seed([uploaded]);
    uploads.push({ data, bytes });
  }
  const delivered = { conversationId: 'file-chat', fileId: 'notes', computerId: 'computer',
    sha256: uploads[0]!.data.sha256, outcome: 'saved' };
  await nats.seed([envelope('test', 'conversation-file-chat', 'file.delivered', delivered)]);
  return uploads;
}

export async function recoveryFiles(source: Awaited<ReturnType<typeof fixture>>,
  directory: string, fault: string) {
  const custody = await recoveryCustody(source.nats, directory, fault);
  const objects = await restoreStorage(onTestFinished);
  const targetObjects = await provisionDisposableObjectTarget('test');
  onTestFinished(targetObjects.close);
  const put = targetObjects.client.putObject.bind(targetObjects.client);
  const writes = vi.spyOn(targetObjects.client, 'putObject');
  const buckets = vi.spyOn(targetObjects.client, 'makeBucket');
  const copied = await natsFixture({ provision: false });
  onTestFinished(copied.close);
  const fga = await openfga();
  onTestFinished(fga.close);
  await seedRecoveryReader(source.nats);
  const uploads = await seedRecoveryFiles(source.nats, objects.client);
  const backupKeyFile = join(directory, 'file-key');
  await writeFile(backupKeyFile, randomBytes(32), { mode: 0o600 });
  const destination = join(directory, 'objects');
  let before: Awaited<ReturnType<typeof collectFileRecovery>>;
  let rights: Awaited<ReturnType<typeof rebuildMembers>>;
  let eventDirectory = '';
  let replayCount = 0;
  let readCount = 0;
  const effects = recoveryEffectProbes();
  async function capture(events: string) {
    eventDirectory = events;
    const runner = new ProjectionRunner(source.db, source.nats.reader, logger);
    for (const projection of [members, conversations, files]) {
      await runner.initialise(projection);
      await runner.run(projection);
    }
    before = await collectFileRecovery(source.db, objects.client);
    rights = await rebuildMembers(fga.apiUrl, 'test', source.nats.reader);
    await collectObjectBackup(source.nats.connection, copied.connection, objects.client,
      { directory: events, destination, backupKeyFile, silo: 'test', attempt: 'before-upgrade',
        writersStopped: true, disposable: true });
    await custody.capture(events, backupKeyFile);
    if (fault === 'corrupt') {
      const archivePath = join(events, 'events.snapshot');
      const archive = await readFile(archivePath);
      await writeFile(archivePath, archive.subarray(0, -1));
    }
    if (fault === 'mixed') {
      const path = join(events, 'descriptor.json');
      const descriptor = descriptorSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      descriptor.attempt = 'different-attempt';
      await writeFile(path, JSON.stringify(descriptor));
    }
  }
  async function restore(target: Nats) {
    async function loseReply(...args: Parameters<typeof put>): Promise<never> {
      await put(...args);
      throw new Error('private-file-completion-canary');
    }
    if (fault === 'objects') {
      writes.mockImplementation(loseReply);
    }
    const options = { directory: destination, eventDirectory, backupKeyFile, silo: 'test',
      attempt: 'before-upgrade', targetSilo: 'test', stopped: true, exclusive: true,
      disposable: true, effectsDisabled: true, memory: custody.memory,
      volumeDirectory: custody.volumeDirectory };
    const result = await restoreRecoveryBackup(source.nats.connection, target.connection,
      objects.client, targetObjects.client, options);
    expect(result).toEqual({ kind: 'events-objects-and-custody-only' });
    custody.expectDeleted();
  }
  async function rebuild(target: Nats, db: Db) {
    replayCount++;
    const runner = new ProjectionRunner(db, target.reader, logger);
    for (const projection of [members, conversations, files]) {
      await runner.initialise(projection);
      await runner.rebuild(projection);
    }
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', target.reader,
      { verifyAgainst: rights.binding });
    expect(rebuilt.verified).toBe(true);
    expect(rebuilt.sequence).toBe(before.checkpoint);
    const after = await collectFileRecovery(db, targetObjects.client);
    checkFileRecovery(before, after, await target.reader.head());
    readCount++;
    await checkRecoveryReads(target, db, targetObjects.client, rebuilt.binding, uploads);
    expect(readCount).toBe(replayCount);
    return { ...after, rightsSequence: rebuilt.sequence, effects: effects() };
  }
  async function expectIsolated(db: Db) {
    effects();
    expect({ replayCount, readCount }).toEqual({ replayCount: 0, readCount: 0 });
    const tables = await db.query("SELECT to_regclass('conversation_files') AS name");
    expect(tables.rows).toEqual([{ name: null }]);
    let expectedWrites = 0;
    if (fault === 'objects') {
      expectedWrites = 1;
    }
    if (['missing-custody', 'resurrected', 'inventory'].includes(fault)) {
      expectedWrites = 2;
    }
    expect(writes).toHaveBeenCalledTimes(expectedWrites);
    expect(buckets).toHaveBeenCalledTimes(expectedWrites > 0 ? 1 : 0);
    expect(await targetObjects.client.bucketExists('files')).toBe(expectedWrites > 0);
  }
  async function transitions(target: Nats, db: Db) {
    await checkRecoveryReads(target, db, targetObjects.client, rights.binding, uploads, true);
  }
  return { capture, restore, rebuild, expectIsolated, transitions };
}
