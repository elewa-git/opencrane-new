import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { collectEventBackup, descriptorSchema } from './event-backup.ts';
import { readPrivateFile, restoreOfflineEventBackup } from './event-restore.ts';

async function restoresWithoutTheSource() {
  const source = await natsFixture();
  const target = await natsFixture({ provision: false });
  const directory = await mkdtemp('/tmp/pilot-offline-events-');
  let sourceClosed = false;
  try {
    const event = envelope('test', 'member-alice', 'member.joined', {
      memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'owner',
    });
    await source.store.append({ event, expectedSequence: 0 });
    const destination = join(directory, 'capture');
    await collectEventBackup(source.connection, { silo: 'test', attempt: 'backup', destination });
    const bytes = readPrivateFile(join(destination, 'descriptor.json'), 1024 * 1024);
    const descriptor = descriptorSchema.parse(JSON.parse(bytes.toString('utf8')));
    const archive = readPrivateFile(join(destination, 'events.snapshot'), 64 * 1024 * 1024);
    await source.close();
    sourceClosed = true;
    const options = { directory, silo: 'test', disposable: true };
    await restoreOfflineEventBackup(target.connection, descriptor, archive, options);
    expect(await target.store.head()).toBe(1);
    const restored = [];
    for await (const row of target.store.readStream('member-alice')) restored.push(row);
    expect(restored).toEqual([{ sequence: 1, event }]);
  } finally {
    if (!sourceClosed) await source.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('restores native event identities and positions while the source is unavailable',
  restoresWithoutTheSource);

async function readsBackAnUncertainCompletion() {
  const source = await natsFixture();
  const target = await natsFixture({ provision: false });
  const directory = await mkdtemp('/tmp/pilot-lost-reply-');
  try {
    const event = envelope('test', 'member-alice', 'member.joined', {
      memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'owner',
    });
    await source.store.append({ event, expectedSequence: 0 });
    await collectEventBackup(source.connection, { silo: 'test', attempt: 'backup',
      destination: join(directory, 'capture') });
    const descriptorBytes = readPrivateFile(join(directory, 'capture', 'descriptor.json'), 1048576);
    const descriptor = descriptorSchema.parse(JSON.parse(descriptorBytes.toString('utf8')));
    const archive = readPrivateFile(join(directory, 'capture', 'events.snapshot'), 67108864);
    const request = target.connection.request.bind(target.connection);
    let transfers = 0;
    async function loseCompletion(...args: Parameters<typeof request>) {
      const reply = await request(...args);
      if (args[0].startsWith('$JS.SNAPSHOT.RESTORE.')) {
        transfers += 1;
        if (!args[1]?.length) throw new Error('Simulated lost completion reply');
      }
      return reply;
    }
    target.connection.request = loseCompletion;
    const options = { directory, silo: 'test', disposable: true };
    await expect(restoreOfflineEventBackup(target.connection, descriptor, archive, options))
      .rejects.toThrow('Offline event restore refused');
    const sent = transfers;
    await expect(restoreOfflineEventBackup(target.connection, descriptor, archive, options))
      .rejects.toThrow('Offline event restore refused');
    await restoreOfflineEventBackup(target.connection, descriptor, archive,
      { ...options, resume: true });
    expect(transfers).toBe(sent);
    expect(await target.store.head()).toBe(1);
  } finally {
    await source.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('reads back a lost completion without retransmission and refuses an unowned retry',
  readsBackAnUncertainCompletion);
