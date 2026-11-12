import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { history, readConnectionSelection, changeConnectionSelection,
  saveBearerConnection } from '@opencrane/models';
import { personalKeyFixture } from './support/personal-key.ts';

async function verifiedKeyIsAvailable() {
  const setup = await personalKeyFixture();
  const policy = await setup.publish();
  await setup.grant('alice');
  await setup.grant('bob');
  async function stage() {
    return { status: 'staged' as const,
      identity: { reference: 'fixture', uid: 'fixture', resourceVersion: '1' } };
  }
  const custody = { stage, network: setup.remote.network };
  const input = { action: 'create', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', changeRef: randomUUID(), expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const saved = await saveBearerConnection(setup.nats.store, setup.binding, 'alice', custody,
    input, setup.accounts[0].key, setup.db);
  const rows = await history(setup.nats.store, `connection-alice-${setup.serverId}-personal`, 'test');
  expect(JSON.stringify(rows)).not.toContain(setup.accounts[0].key);
  await changeConnectionSelection(setup.nats.store, setup.binding, 'alice', {
    action: 'select', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', profileRevision: saved.sequence, expectedSequence: 0,
    changeRef: randomUUID(),
  });
  const selected = await readConnectionSelection(setup.nats.store, setup.binding, 'alice',
    setup.serverId, undefined, 'read_fixture_quote');
  expect(selected.status).toBe('verified');
  const missing = await readConnectionSelection(setup.nats.store, setup.binding, 'bob',
    setup.serverId, undefined, 'read_fixture_quote');
  expect(missing.status).toBe('unavailable');
}
it('verifies a saved bearer through the reviewed identity tool for its own member only',
  verifiedKeyIsAvailable, 120_000);
