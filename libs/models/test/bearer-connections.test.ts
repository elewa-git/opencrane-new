import { z } from 'zod';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import type { AppendCommand } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { saveBearerConnection, foldConnection, changePersonalConnection }
  from '../src/bearer-connections.ts';
import type { ConnectionStage, connectionCustody } from '../src/connection-custody.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
const material = 'synthetic-private-material';
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const joined = envelope('test', 'member-alice', 'member.joined', {
    memberId: 'alice', role: 'member', email: 'alice@example.test', displayName: 'Alice',
  });
  await nats.store.append({ event: joined, expectedSequence: 0 });
  await auth.handler.handle(joined, pgDb(storage.queue));
  for (const memberId of ['bob', 'admin']) {
    const role = memberId === 'admin' ? 'admin' : 'member';
    const member = envelope('test', `member-${memberId}`, 'member.joined', {
      memberId, role, email: `${memberId}@example.test`, displayName: memberId,
    });
    await nats.store.append({ event: member, expectedSequence: 0 });
    await auth.handler.handle(member, pgDb(storage.queue));
  }
  const registered = envelope('test', 'mcp-server', 'mcp.server_registered', {
    serverId: 'server', kind: 'remote', locator: 'https://example.test/mcp', registeredBy: 'admin',
  });
  const catalogue = { serverId: 'server', connectionId: 'installed', accountMode: 'personal',
    tools: [], toolCount: 0, schemaDigest: catalogueDigest([]),
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  const discovered = envelope('test', 'mcp-server', 'mcp.server_discovered', catalogue);
  const published = envelope('test', 'mcp-server', 'mcp.server_published', {
    serverId: 'server', publishedBy: 'admin',
  });
  await nats.seed([registered, discovered]);
  const policyRevision = await nats.store.head('mcp-server');
  const review = envelope('test', 'mcp-server', 'mcp.server_reviewed', {
    serverId: 'server', catalogueDigest: catalogue.schemaDigest, connectionId: 'installed',
    accountMode: 'personal', policyRevision, reviewedBy: 'admin', tools: [],
  });
  review.principal = { kind: 'human', id: 'admin' };
  await nats.seed([review, published]);
}
async function close() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
function fixture() {
  counter += 1;
  const input = { action: 'create' as const, serverId: 'server', connectionId: 'installed',
    profileId: `profile${counter}`, changeRef: `change${counter}`, expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const subject = `connection-alice-server-${input.profileId}`;
  const staged = new Map<string, string>();
  function stage(request: ConnectionStage, supplied: string) {
    const previous = staged.get(request.operationId);
    if (previous !== undefined && previous !== supplied) {
      const conflict = { status: 'conflict' as const };
      return Promise.resolve(conflict);
    }
    staged.set(request.operationId, supplied);
    const identity = { reference: `mcp-${input.profileId}-g${request.generation}`,
      uid: `uid-${request.generation}`, resourceVersion: String(request.generation) };
    const result = { status: 'staged' as const, identity };
    return Promise.resolve(result);
  }
  const custody: Pick<ReturnType<typeof connectionCustody>, 'stage'> = { stage };
  async function save(command: unknown = input, supplied = material) {
    return saveBearerConnection(nats.store, binding, 'alice', custody, command, supplied);
  }
  return { input, subject, custody, save };
}
async function stageFailure(action: 'create' | 'rotate') {
  const test = fixture();
  let sequence = 0;
  let generation = 0;
  if (action === 'rotate') {
    const created = await test.save();
    sequence = created.sequence;
    generation = 1;
  }
  function failStage(): Promise<never> {
    return Promise.reject(new Error(material));
  }
  test.custody.stage = failStage;
  const input = { ...test.input, action, changeRef: 'failed', expectedSequence: sequence,
    expectedGeneration: generation };
  await expect(test.save(input)).rejects.toThrow('Connection custody unavailable');
  expect(await nats.store.head(test.subject)).toBe(sequence);
}
it.each(['create', 'rotate'] as const)('records no %s when custody fails', stageFailure);
async function rotationAndReplay() {
  const test = fixture();
  const created = await test.save();
  const rotation = { ...test.input, action: 'rotate' as const, changeRef: 'rotation',
    expectedSequence: created.sequence, expectedGeneration: 1 };
  const rotated = await test.save(rotation, 'synthetic-replacement');
  expect(rotated.generation).toBe(2);
  await expect(test.save(rotation)).rejects.toThrow();
  const stale = { ...rotation, changeRef: 'stale', expectedSequence: rotated.sequence };
  await expect(test.save(stale)).rejects.toThrow('Connection conflict');
  const rows = await history(nats.store, test.subject, 'test');
  expect(rows).toHaveLength(2);
  const state = foldConnection(rows);
  expect(state).toMatchObject({ status: 'saved_unverified', sequence: rotated.sequence,
    data: { secretRef: `secret:mcp-${test.input.profileId}-g2`,
      activation: { generation: 2, uid: 'uid-2', resourceVersion: '2',
        reason: 'bearer_rotation' } } });
  const publicData = JSON.stringify({ rows, state, created, rotated });
  expect(publicData).not.toContain(material);
  expect(publicData).not.toContain('synthetic-replacement');
  expect(await test.save()).toEqual(created);
  expect(await nats.store.head(test.subject)).toBe(rotated.sequence);
}
it('rotates once, refuses stale generations and replays only custody references', rotationAndReplay);
async function legacyClosed() {
  const test = fixture();
  const data = { userId: 'alice', serverId: 'server', profile: test.input.profileId,
    secretRef: 'secret:legacy' };
  const event = envelope('test', test.subject, 'connection.created', data);
  await nats.seed([event]);
  const rows = await history(nats.store, test.subject, 'test');
  expect(foldConnection(rows).status).toBe('unavailable');
  const input = { ...test.input, action: 'rotate' as const,
    expectedSequence: rows[0]!.sequence, expectedGeneration: 1 };
  await expect(test.save(input)).rejects.toThrow('Connection conflict');
  expect(await history(nats.store, test.subject, 'test')).toHaveLength(1);
}
it('keeps a legacy profile without an exact generation unavailable', legacyClosed);

async function incompleteClosed() {
  const test = fixture();
  await test.save();
  const rows = await history(nats.store, test.subject, 'test');
  const incomplete = structuredClone(rows);
  const dataSchema = z.object({ activation: z.object({ uid: z.string().optional() }).loose() }).loose();
  const data = dataSchema.parse(incomplete[0]!.event.data);
  delete data.activation.uid;
  incomplete[0]!.event.data = data;
  expect(foldConnection(incomplete).status).toBe('unavailable');
}
it('keeps an incomplete exact identity unavailable on replay', incompleteClosed);
async function concurrentRotations() {
  const test = fixture();
  const created = await test.save();
  const first = { ...test.input, action: 'rotate', changeRef: 'first',
    expectedSequence: created.sequence, expectedGeneration: 1 };
  const second = { ...first, changeRef: 'second' };
  const attempts = await Promise.allSettled([test.save(first), test.save(second)]);
  function succeeded(result: PromiseSettledResult<unknown>) {
    return result.status === 'fulfilled';
  }
  expect(attempts.filter(succeeded)).toHaveLength(1);
  const rows = await history(nats.store, test.subject, 'test');
  expect(rows).toHaveLength(2);
  expect(foldConnection(rows).data?.activation.generation).toBe(2);
}
it('saves only one of two competing rotations', concurrentRotations);
async function refusesForeign() {
  const test = fixture();
  await expect(saveBearerConnection(nats.store, binding, 'outsider', test.custody,
    test.input, material)).rejects.toThrow();
  const foreign = { ...test.input, connectionId: 'foreign' };
  await expect(test.save(foreign)).rejects.toThrow('Connection server unavailable');
  expect(await nats.store.head(test.subject)).toBe(0);
}
it('refuses a non-member and a different installation', refusesForeign);
async function unknownStage() {
  const test = fixture();
  function unknown() {
    const result = { status: 'unknown' as const };
    return Promise.resolve(result);
  }
  test.custody.stage = unknown;
  await expect(test.save()).rejects.toThrow('Connection custody unavailable');
  expect(await history(nats.store, test.subject, 'test')).toEqual([]);
}
it('keeps an unknown custody outcome unrecorded', unknownStage);

async function lostAppendReply() {
  const test = fixture();
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: AppendCommand) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error('Reply lost') };
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementation(loseReply);
  try {
    await expect(test.save()).rejects.toThrow('Connection append unconfirmed');
  } finally {
    fault.mockRestore();
  }
  const recovered = await test.save();
  expect(recovered.generation).toBe(1);
  expect(await history(nats.store, test.subject, 'test')).toHaveLength(1);
  const changed = { ...test.input, appendUntil: test.input.appendUntil + 1 };
  await expect(test.save(changed)).rejects.toThrow('Connection conflict');
  expect(await nats.store.head(test.subject)).toBe(recovered.sequence);
}
it('recovers a lost append reply and refuses changed retry details', lostAppendReply);

function controlInput(test: ReturnType<typeof fixture>, sequence: number) {
  return { action: 'revoke' as const, userId: 'alice', serverId: 'server',
    profileId: test.input.profileId, changeRef: 'stop', expectedSequence: sequence };
}
async function ownerRevoke() {
  const test = fixture();
  const created = await test.save();
  const input = controlInput(test, created.sequence);
  const result = await changePersonalConnection(nats.store, binding, 'alice', input);
  expect(result.status).toBe('revoked');
  const rows = await history(nats.store, test.subject, 'test');
  expect(rows).toHaveLength(2);
  expect(rows[1]!.event).toMatchObject({ type: 'connection.revoked',
    principal: { kind: 'human', id: 'alice' },
    data: { revokedBy: 'alice', expectedSequence: created.sequence, reason: 'owner_requested' } });
  expect(foldConnection(rows).status).toBe('unavailable');
  const retry = await changePersonalConnection(nats.store, binding, 'alice', input);
  expect(retry).toEqual(result);
  const rotate = { ...test.input, action: 'rotate', changeRef: 'after-revoke',
    expectedSequence: result.sequence, expectedGeneration: 1 };
  await expect(test.save(rotate)).rejects.toThrow('Connection conflict');
  expect(JSON.stringify({ rows, result })).not.toContain(material);
}
it('lets only the owner invalidate a profile and recovers the same revoke', ownerRevoke);

async function refusedControl() {
  const test = fixture();
  const created = await test.save();
  const input = controlInput(test, created.sequence);
  for (const actor of ['bob', 'admin']) {
    await expect(changePersonalConnection(nats.store, binding, actor, input)).rejects.toThrow();
  }
  const disable = { ...input, action: 'disable', expectedSequence: 0 };
  await expect(changePersonalConnection(nats.store, binding, 'alice', disable)).rejects.toThrow();
  const changedOwner = { ...input, userId: 'bob' };
  await expect(changePersonalConnection(nats.store, binding, 'bob', changedOwner)).rejects.toThrow();
  for (const patch of [{ profileId: 'foreign' }, { siloId: 'foreign' }, { ownerId: 'bob' },
    { reason: material }, { expectedSequence: 0 }]) {
    const forged = { ...input, ...patch };
    await expect(changePersonalConnection(nats.store, binding, 'alice', forged)).rejects.toThrow();
  }
  const wrongSilo = { ...binding, silo: 'foreign' };
  await expect(changePersonalConnection(nats.store, wrongSilo, 'alice', input)).rejects.toThrow();
  const wrongProfile = { ...disable, profileId: 'foreign' };
  await expect(changePersonalConnection(nats.store, binding, 'admin', wrongProfile)).rejects.toThrow();
  expect(await nats.store.head(test.subject)).toBe(created.sequence);
  expect(await nats.store.head('connection-control-alice-server')).toBe(0);
}
it('refuses foreign owners, silos, profiles, ordinary disable and stale revoke', refusedControl);

async function lostRevokeReply() {
  const test = fixture();
  const created = await test.save();
  const input = controlInput(test, created.sequence);
  const append = nats.store.append.bind(nats.store);
  async function loseReply(command: AppendCommand) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error(material) };
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementation(loseReply);
  try {
    await expect(changePersonalConnection(nats.store, binding, 'alice', input))
      .rejects.toThrow('Connection append unconfirmed');
  } finally {
    fault.mockRestore();
  }
  const result = await changePersonalConnection(nats.store, binding, 'alice', input);
  expect(result.status).toBe('revoked');
  expect(await history(nats.store, test.subject, 'test')).toHaveLength(2);
  const changed = { ...input, expectedSequence: result.sequence };
  await expect(changePersonalConnection(nats.store, binding, 'alice', changed))
    .rejects.toThrow('Connection conflict');
}
it('recovers a lost revoke reply without copying a dependency error', lostRevokeReply);

async function revokeDefeatsRotation() {
  const test = fixture();
  const created = await test.save();
  const input = controlInput(test, created.sequence);
  const stage = test.custody.stage;
  async function revokeDuringStage(request: ConnectionStage, supplied: string) {
    const result = await stage(request, supplied);
    await changePersonalConnection(nats.store, binding, 'alice', input);
    return result;
  }
  test.custody.stage = revokeDuringStage;
  const rotate = { ...test.input, action: 'rotate', changeRef: 'racing',
    expectedSequence: created.sequence, expectedGeneration: 1 };
  await expect(test.save(rotate)).rejects.toThrow('Connection append unconfirmed');
  const rows = await history(nats.store, test.subject, 'test');
  expect(rows).toHaveLength(2);
  expect(foldConnection(rows).status).toBe('unavailable');
}
it('refuses a rotation staged before an owner revoked the profile', revokeDefeatsRotation);

async function adminDisable() {
  const test = fixture();
  const created = await test.save();
  const input = { ...controlInput(test, 0), action: 'disable' };
  const stage = test.custody.stage;
  async function disableDuringStage(request: ConnectionStage, supplied: string) {
    const result = await stage(request, supplied);
    await changePersonalConnection(nats.store, binding, 'admin', input);
    return result;
  }
  test.custody.stage = disableDuringStage;
  const rotate = { ...test.input, action: 'rotate', changeRef: 'racing-disable',
    expectedSequence: created.sequence, expectedGeneration: 1 };
  await expect(test.save(rotate)).rejects.toThrow('Connection disabled');
  expect(await nats.store.head(test.subject)).toBe(created.sequence);
  const rows = await history(nats.store, 'connection-control-alice-server', 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event).toMatchObject({ type: 'connection.disabled',
    principal: { kind: 'human', id: 'admin' },
    data: { userId: 'alice', serverId: 'server', disabledBy: 'admin', reason: 'admin_disabled' } });
  const retry = await changePersonalConnection(nats.store, binding, 'admin', input);
  expect(retry.status).toBe('disabled');
  expect(retry.sequence).toBe(rows[0]!.sequence);
  const reconnect = fixture();
  const stageSpy = vi.spyOn(reconnect.custody, 'stage');
  await expect(reconnect.save()).rejects.toThrow('Connection disabled');
  expect(stageSpy).not.toHaveBeenCalled();
  expect(await nats.store.head(reconnect.subject)).toBe(0);
  const revoke = controlInput(test, created.sequence);
  await changePersonalConnection(nats.store, binding, 'alice', revoke);
  await expect(reconnect.save()).rejects.toThrow('Connection disabled');
  expect(JSON.stringify({ rows, retry })).not.toContain(material);
}
it('keeps an admin disable across staging, owner revoke and a new profile', adminDisable);
