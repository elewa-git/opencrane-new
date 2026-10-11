import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { conversationKeys } from '@opencrane/projections';
import { personalKeyHandler } from '../src/personal-keys.ts';
import { dispatcherHandlerNames } from '../src/dispatcher-handlers.ts';
import { lifecycleHandlers } from '../src/lifecycle.ts';
import { database } from '../../../libs/projections/test/database.ts';

async function preparesOnce() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const directory = await mkdtemp(`${tmpdir()}/personal-keys-`);
  const keys = conversationKeys(directory);
  const handler = personalKeyHandler(nats.store, keys);
  const joined = event('joined', 'member-alice', 'member.joined');
  joined.data = { ...joined.data, personalAssistant: 'none' };
  try {
    expect(dispatcherHandlerNames({ PERSONAL_KEY_DIRECTORY: directory }))
      .toContain('prepare-personal-key');
    await handler.handle(joined, storage.db);
    expect(await readdir(directory)).toEqual([]);
    await nats.seed([joined]);
    await handler.handle(joined, storage.db);
    const filenames = await readdir(directory);
    expect(filenames).toHaveLength(1);
    const filename = `${directory}/${filenames[0]!}`;
    const originalKey = await readFile(filename);
    await handler.handle(joined, storage.db);
    const encrypted = keys.encrypt('test', 'personal:alice', 'private answer');
    await nats.stop();
    await nats.restart();
    const reopened = conversationKeys(directory);
    await personalKeyHandler(nats.store, reopened).handle(joined, storage.db);
    expect(await readFile(filename)).toEqual(originalKey);
    expect(reopened.decrypt('test', 'personal:alice', encrypted)).toBe('private answer');
    await lifecycleHandlers(nats.store)[0].handle(joined, storage.db);
    expect(await nats.store.head()).toBe(1);
    const removed = event('removed', 'member-alice', 'member.removed');
    await nats.seed([removed]);
    await rm(filename);
    await handler.handle(joined, storage.db);
    expect(await readdir(directory)).toEqual([]);
    const owner = event('bootstrap', 'member-bootstrap-owner', 'silo.owner_bootstrapped');
    await nats.seed([owner]);
    await handler.handle(owner, storage.db);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await nats.store.head()).toBe(3);
  } finally {
    await storage.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('prepares one private key across delivery and restart without provisioning an assistant',
  preparesOnce);
