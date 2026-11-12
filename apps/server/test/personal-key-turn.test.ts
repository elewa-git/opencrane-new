import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { history, readConnectionSelection, changeConnectionSelection,
  savePersonalKey } from '@opencrane/models';
import { personalKeyFixture } from './support/personal-key.ts';

async function verifiedKeyIsAvailable() {
  const setup = await personalKeyFixture();
  const policy = await setup.publish();
  await setup.grant('alice');
  await setup.grant('bob');
  function stage() {
    return Promise.resolve({ status: 'staged' as const,
      identity: { reference: 'fixture', uid: 'fixture', resourceVersion: '1' } });
  }
  const custody = { stage, network: setup.remote.network };
  const input = { action: 'create', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', changeRef: randomUUID(), expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const saved = await savePersonalKey(setup.nats.store, setup.binding, 'alice',
    { custody, db: setup.db, network: setup.remote.network },
    { command: input, material: setup.accounts[0].key });
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
  const rotation = { ...input, action: 'rotate', changeRef: randomUUID(),
    expectedSequence: saved.sequence, expectedGeneration: 1 };
  await savePersonalKey(setup.nats.store, setup.binding, 'alice',
    { custody, db: setup.db, network: setup.remote.network },
    { command: rotation, material: setup.accounts[1].key });
  const changed = await readConnectionSelection(setup.nats.store, setup.binding, 'alice',
    setup.serverId, undefined, 'read_fixture_quote');
  expect(changed.status).toBe('unavailable');
}
it('verifies a saved bearer through the reviewed identity tool for its own member only',
  verifiedKeyIsAvailable, 120_000);

async function refuseInvalidOrUngrantableKey() {
  const setup = await personalKeyFixture();
  const policy = await setup.publish();
  function stage() {
    return Promise.resolve({ status: 'staged' as const,
      identity: { reference: 'fixture', uid: 'fixture', resourceVersion: '1' } });
  }
  const custody = { stage, network: setup.remote.network };
  const input = { action: 'create', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', changeRef: randomUUID(), expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const connectionsBeforeCheck = setup.remote.connections();
  await expect(savePersonalKey(setup.nats.store, setup.binding, 'alice',
    { custody, db: setup.db, network: setup.remote.network },
    { command: input, material: setup.accounts[0].key })).rejects.toThrow();
  expect(setup.remote.connections()).toBe(connectionsBeforeCheck);
  await setup.grant('alice');
  await expect(savePersonalKey(setup.nats.store, setup.binding, 'alice',
    { custody, db: setup.db, network: setup.remote.network },
    { command: input, material: randomUUID() })).rejects.toThrow('Identity not verified');
  expect(await setup.nats.store.head(`connection-alice-${setup.serverId}-personal`)).toBe(0);
}
it('refuses to check an ungranted key or save a key whose identity check fails',
  refuseInvalidOrUngrantableKey, 120_000);

async function refuseGrantRevokedSave(when: 'stage' | 'append') {
  const setup = await personalKeyFixture();
  const policy = await setup.publish();
  await setup.grant('alice');
  async function stage() {
    if (when === 'stage') await setup.grant('alice', 'member', 'revoke');
    return { status: 'staged' as const,
      identity: { reference: 'fixture', uid: 'fixture', resourceVersion: '1' } };
  }
  const input = { action: 'create', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', changeRef: randomUUID(), expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  let reachedAppend = false;
  const originalAppend = setup.nats.store.append.bind(setup.nats.store);
  async function append(command: Parameters<typeof setup.nats.store.append>[0]) {
    const event = command.event;
    const saving = typeof event === 'object' && event !== null && 'type' in event &&
      event.type === 'connection.created';
    if (when === 'append' && saving) {
      reachedAppend = true;
      await setup.grant('alice', 'member', 'revoke');
    }
    return originalAppend(command);
  }
  const spy = vi.spyOn(setup.nats.store, 'append').mockImplementation(append);
  const dependencies = { custody: { stage }, db: setup.db, network: setup.remote.network };
  try {
    await expect(savePersonalKey(setup.nats.store, setup.binding, 'alice', dependencies,
      { command: input, material: setup.accounts[0].key })).rejects.toThrow(
        when === 'append' ? 'Connection append unconfirmed' : 'Selection access unavailable');
    if (when === 'append') expect(reachedAppend).toBe(true);
    expect(await setup.nats.store.head(`connection-alice-${setup.serverId}-personal`)).toBe(0);
  } finally {
    spy.mockRestore();
  }
}
async function refuseGrantRevokedDuringStage() {
  await refuseGrantRevokedSave('stage');
}
async function refuseGrantRevokedAtAppend() {
  await refuseGrantRevokedSave('append');
}
it('refuses the save when its grant is revoked while custody stages the checked key',
  refuseGrantRevokedDuringStage, 120_000);
it('binds its final grant check to the append', refuseGrantRevokedAtAppend, 120_000);
