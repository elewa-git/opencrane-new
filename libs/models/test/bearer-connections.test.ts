import { z } from 'zod';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import type { AppendCommand, StoredEvent } from '@opencrane/event-store';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { type Db, pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { saveBearerConnection, foldConnection, changePersonalConnection }
  from '../src/bearer-connections.ts';
import { withConnectionStage } from '../src/connection-stage-lock.ts';
import { reconcileConnectionStage } from '../src/connection-reconciliation.ts';
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
  const checkedAt = Date.now();
  const catalogue = { serverId: 'server', connectionId: 'installed', accountMode: 'personal',
    tools: [], toolCount: 0, schemaDigest: catalogueDigest([]),
    checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(checkedAt + 300_000).toISOString() };
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
function waitingConnectionDatabase(): Db {
  const database = pgDb(storage.queue);
  function waitForConnectionLock<Result>(name: string, work: (db: Db) => Promise<Result>) {
    // Wait for the fixture's lock so each test reaches the condition it checks.
    return database.lock!(name, work);
  }
  return { ...database, lock: waitForConnectionLock };
}
function fixture(memberId = 'alice', database = waitingConnectionDatabase()) {
  counter += 1;
  const input = { action: 'create' as const, serverId: 'server', connectionId: 'installed',
    profileId: `profile${counter}`, changeRef: `change${counter}`, expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const subject = `connection-${memberId}-server-${input.profileId}`;
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
    return saveBearerConnection(nats.store, binding, memberId, custody, command, supplied, database);
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
  const changedRetry = { ...test.input, expectedGeneration: 1 };
  await expect(test.save(changedRetry)).rejects.toThrow('Connection conflict');
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
    test.input, material, pgDb(storage.queue))).rejects.toThrow();
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

async function joinMember(memberId: string, role: 'member' | 'admin' = 'member') {
  const data = { memberId, role, email: `${memberId}@example.test`, displayName: memberId };
  const event = envelope('test', `member-${memberId}`, 'member.joined', data);
  const command = { event, expectedSequence: 0 };
  const result = await nats.store.append(command);
  expect(result.status).toBe('appended');
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(event, pgDb(storage.queue));
}

async function disableBeforeSaveAppend(action: 'create' | 'rotate' | 'reconnect') {
  const memberId = `commit-${action}`;
  await joinMember(memberId);
  const existing = fixture(memberId);
  const created = await existing.save();
  const disable = { ...controlInput(existing, 0), action: 'disable', userId: memberId };
  if (action === 'reconnect') {
    const old = fixture(memberId);
    const saved = await old.save();
    const revoke = { ...controlInput(old, saved.sequence), userId: memberId };
    await changePersonalConnection(nats.store, binding, memberId, revoke);
  }
  let target = existing;
  let input: unknown = { ...existing.input, action: 'rotate', changeRef: 'rotation',
    expectedSequence: created.sequence, expectedGeneration: 1 };
  let expectedSequence = created.sequence;
  if (action !== 'rotate') {
    target = fixture(memberId);
    input = target.input;
    expectedSequence = 0;
  }
  const append = nats.store.append.bind(nats.store);
  let disabledSequence = 0;
  async function disableThenAppend(command: AppendCommand) {
    // Pause the save after its last check, then let the real disable finish first.
    fault.mockRestore();
    const disabled = await changePersonalConnection(nats.store, binding, 'admin', disable);
    disabledSequence = disabled.sequence;
    return append(command);
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(disableThenAppend);
  try {
    await expect(target.save(input)).rejects.toThrow('Connection append unconfirmed');
  } finally {
    fault.mockRestore();
  }
  expect(disabledSequence).toBeGreaterThan(created.sequence);
  expect(await nats.store.head(target.subject)).toBe(expectedSequence);
  const blocked = await history(nats.store, `connection-control-${memberId}-server`, 'test');
  expect(blocked).toHaveLength(1);
  expect(blocked[0]!.sequence).toBe(disabledSequence);
  expect(JSON.stringify(blocked)).not.toContain(material);
}
it.each(['create', 'rotate', 'reconnect'] as const)(
  'refuses %s when disable commits after the last save check', disableBeforeSaveAppend);

async function disableDuringFinalSaveCheck() {
  const memberId = 'final-control-watch';
  await joinMember(memberId);
  const test = fixture(memberId);
  const created = await test.save();
  const disable = { ...controlInput(test, 0), action: 'disable', userId: memberId };
  const rotate = { ...test.input, action: 'rotate', changeRef: 'final-check',
    expectedSequence: created.sequence, expectedGeneration: 1 };
  const head = nats.store.head.bind(nats.store);
  const stage = test.custody.stage;
  let staged = false;
  async function finishStage(request: ConnectionStage, supplied: string) {
    const result = await stage(request, supplied);
    staged = true;
    return result;
  }
  async function disableAfterBlockerRead(subject?: string, deadline?: number) {
    if (staged && subject === 'mcp-server') {
      staged = false;
      await changePersonalConnection(nats.store, binding, 'admin', disable);
    }
    return head(subject, deadline);
  }
  test.custody.stage = finishStage;
  const fault = vi.spyOn(nats.store, 'head');
  fault.mockImplementation(disableAfterBlockerRead);
  try {
    await expect(test.save(rotate)).rejects.toThrow('Authority changed');
  } finally {
    fault.mockRestore();
  }
  expect(await nats.store.head(test.subject)).toBe(created.sequence);
  const blocked = await history(nats.store, `connection-control-${memberId}-server`, 'test');
  expect(blocked).toHaveLength(1);
}
it('watches the control stream after the final blocker read', disableDuringFinalSaveCheck);

const membershipChanges = [
  { action: 'disable', retry: false },
  { action: 'disable', retry: true },
  { action: 'revoke', retry: false },
  { action: 'revoke', retry: true },
] as const;
async function losesMembershipDuringHistory(change: typeof membershipChanges[number]) {
  const memberId = `history-${change.action}-${String(change.retry)}`;
  const adminId = `admin-${memberId}`;
  await joinMember(memberId);
  await joinMember(adminId, 'admin');
  const test = fixture(memberId);
  const created = await test.save();
  let actorId = memberId;
  let subject = test.subject;
  let expectedSequence = created.sequence;
  if (change.action === 'disable') {
    actorId = adminId;
    subject = `connection-control-${memberId}-server`;
    expectedSequence = 0;
  }
  const input = { ...controlInput(test, expectedSequence),
    action: change.action, userId: memberId };
  if (change.retry) {
    const saved = await changePersonalConnection(nats.store, binding, actorId, input);
    expectedSequence = saved.sequence;
  }
  const readStream = nats.store.readStream.bind(nats.store);
  let changed = false;
  async function* changeDuringHistory(stream: string, from?: number, deadline?: number) {
    yield* readStream(stream, from, deadline);
    if (stream !== test.subject || changed) {
      return;
    }
    changed = true;
    let type = 'member.removed';
    let data: unknown = { memberId: actorId, removedBy: 'admin' };
    if (change.action === 'disable') {
      type = 'member.role_changed';
      data = { memberId: actorId, previousRole: 'admin', newRole: 'member', changedBy: 'admin' };
    }
    const event = envelope('test', `member-${actorId}`, type, data);
    await nats.seed([event]);
  }
  const fault = vi.spyOn(nats.store, 'readStream');
  fault.mockImplementation(changeDuringHistory);
  let refusal = 'Active silo membership required';
  if (change.action === 'disable') {
    refusal = 'Owner or Admin required';
  }
  try {
    await expect(changePersonalConnection(nats.store, binding, actorId, input))
      .rejects.toThrow(refusal);
  } finally {
    fault.mockRestore();
  }
  expect(changed).toBe(true);
  expect(await nats.store.head(subject)).toBe(expectedSequence);
}
it.each(membershipChanges)(
  'rechecks membership after profile history for $action (retry: $retry)',
  losesMembershipDuringHistory);

async function lateAppendCannotFollowDeletion(next: 'rotate' | 'revoke' | 'race' | 'create') {
  const memberId = `late-append-${next}`;
  await joinMember(memberId);
  const test = fixture(memberId);
  let sequence = 0;
  let generation = 0;
  if (next !== 'create') {
    const created = await test.save();
    sequence = created.sequence;
    generation = created.generation;
  }
  const action = next === 'create' ? 'create' : 'rotate';
  const rotation = { ...test.input, action, changeRef: 'late',
    expectedSequence: sequence, expectedGeneration: generation };
  const stage = test.custody.stage;
  let candidate: ConnectionStage | undefined;
  let staged: Awaited<ReturnType<typeof stage>> | undefined;
  async function captureStage(input: ConnectionStage, supplied: string) {
    candidate = input;
    staged = await stage(input, supplied);
    return staged;
  }
  test.custody.stage = captureStage;
  const append = nats.store.append.bind(nats.store);
  let delayed: AppendCommand | undefined;
  function loseAppend(command: AppendCommand) {
    delayed = command;
    const result = { status: 'unavailable' as const, cause: new Error(material) };
    return Promise.resolve(result);
  }
  const fault = vi.spyOn(nats.store, 'append');
  fault.mockImplementationOnce(loseAppend);
  await expect(test.save(rotation)).rejects.toThrow('Connection append unconfirmed');
  fault.mockRestore();
  let deletes = 0;
  function recover() {
    const result = { ...staged!, status: 'recovered' as const };
    return Promise.resolve(result);
  }
  async function remove() {
    // Deliver the lost publish just before deletion; the closure must already refuse it.
    const result = await append(delayed!);
    expect(result.status).toBe('conflict');
    deletes += 1;
    return { status: 'deleted' as const };
  }
  const custody = { recover, remove };
  const db = pgDb(storage.queue);
  expect(await reconcileConnectionStage(nats.store, db, custody, candidate!))
    .toEqual({ status: 'retained' });
  async function saveBeforeClosure(command: AppendCommand) {
    expect((await append(delayed!)).status).toBe('appended');
    return append(command);
  }
  const closureAppend = vi.spyOn(nats.store, 'append');
  if (next === 'race') {
    closureAppend.mockImplementationOnce(saveBeforeClosure);
  }
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(candidate!.appendUntil + 1);
  try {
    const expected = next === 'race' ? 'retained' : 'deleted';
    expect(await reconcileConnectionStage(nats.store, db, custody, candidate!))
      .toEqual({ status: expected });
  } finally {
    now.mockRestore();
    closureAppend.mockRestore();
  }
  const rows = await history(nats.store, test.subject, 'test');
  const state = foldConnection(rows);
  if (next === 'race') {
    expect(deletes).toBe(0);
    expect(rows.at(-1)!.event.type).toBe('connection.refreshed');
    expect(state.data?.activation.generation).toBe(2);
    return;
  }
  expect(deletes).toBe(1);
  await continueAfterClosure(test, memberId, next, rotation, rows);
}
async function continueAfterClosure(test: ReturnType<typeof fixture>, memberId: string,
  next: string, rotation: object, rows: StoredEvent[]) {
  const state = foldConnection(rows);
  expect(rows.at(-1)!.event.type).toBe('connection.operation_closed');
  const staging = vi.spyOn(test.custody, 'stage');
  const retry = { ...rotation, expectedSequence: state.sequence };
  await expect(test.save(retry)).rejects.toThrow('Connection conflict');
  expect(staging).not.toHaveBeenCalled();
  if (next === 'create') {
    const freshReference = { ...test.input, changeRef: 'new', expectedSequence: state.sequence };
    await expect(test.save(freshReference)).rejects.toThrow('Connection conflict');
    expect((await fixture(memberId).save()).generation).toBe(1);
    return;
  }
  expect(state).toMatchObject({ status: 'saved_unverified',
    data: { secretRef: `secret:mcp-${test.input.profileId}-g1`, activation: { generation: 1 } } });
  assertInvalidClosuresUnavailable(rows);
  if (next === 'revoke') {
    const revoke = { ...controlInput(test, state.sequence), userId: memberId };
    expect((await changePersonalConnection(nats.store, binding, memberId, revoke)).status)
      .toBe('revoked');
    return;
  }
  const freshRotation = { ...retry, changeRef: 'fresh' };
  const saved = await test.save(freshRotation);
  expect(saved.generation).toBe(3);
  expect(staging).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ generation: 3 }), material);
  expect(await test.save(freshRotation)).toEqual(saved);
  const replayed = foldConnection(await history(nats.store, test.subject, 'test'));
  expect(replayed.data?.activation.generation).toBe(3);
}
it.each(['rotate', 'revoke', 'race', 'create'] as const)(
  'orders a lost save against closure and supports the next %s', lateAppendCannotFollowDeletion);

function assertInvalidClosuresUnavailable(rows: StoredEvent[]) {
  const recordSchema = z.record(z.string(), z.unknown());
  const profileSchema = z.looseObject({
    userId: z.string(), serverId: z.string(), profile: z.string() });
  const activationSchema = z.looseObject({ activation: recordSchema });
  const patches = [
    { userId: 'foreign' }, { serverId: 'foreign' }, { profile: 'foreign' },
    { expectedSequence: 0 }, { generation: 1 }, { appendUntil: Date.now() + 60_000 },
    { reason: 'foreign' }, { generation: 0 },
  ];
  for (const patch of patches) {
    const changed = structuredClone(rows);
    const closure = changed.at(-1)!;
    const data = recordSchema.parse(closure.event.data);
    closure.event.data = { ...data, ...patch };
    expect(foldConnection(changed).status).toBe('unavailable');
  }
  for (const field of ['principal', 'system', 'silo', 'subject', 'sequence'] as const) {
    const changed = structuredClone(rows);
    const closure = changed.at(-1)!;
    if (field === 'principal') {
      closure.event.principal = { kind: 'human', id: 'models' };
    } else if (field === 'system') {
      closure.event.principal = { kind: 'system', id: 'foreign' };
    } else if (field === 'sequence') {
      closure.sequence = rows[0]!.sequence;
    } else {
      closure.event[field] = 'foreign';
    }
    expect(foldConnection(changed).status).toBe('unavailable');
  }
  for (const field of ['userId', 'serverId', 'profile'] as const) {
    const changed = structuredClone(rows);
    const closure = changed.at(-1)!;
    const data = profileSchema.parse(closure.event.data);
    data[field] = 'foreign';
    closure.event.data = data;
    closure.event.subject = `connection-${data.userId}-${data.serverId}-${data.profile}`;
    expect(foldConnection(changed).status).toBe('unavailable');
  }
  const closed = rows.at(-1)!;
  const closureData = recordSchema.parse(closed.event.data);
  const repeated = structuredClone(closed);
  repeated.sequence += 1;
  repeated.event.data = { ...closureData, expectedSequence: closed.sequence, generation: 3 };
  expect(foldConnection([...rows, repeated]).status).toBe('unavailable');
  const original = structuredClone(rows);
  original.at(-1)!.event.data = { ...closureData, operationId: rows[0]!.event.id };
  expect(foldConnection(original).status).toBe('unavailable');
  const revoked = structuredClone(rows);
  revoked[0]!.event.type = 'connection.revoked';
  revoked.at(-1)!.event.data = { ...closureData, generation: 1 };
  expect(foldConnection(revoked)).toMatchObject({ status: 'unavailable', closedOperations: [] });
  const activation = structuredClone(rows[0]!);
  const saved = activationSchema.parse(activation.event.data);
  activation.sequence = closed.sequence + 1;
  activation.event.type = 'connection.refreshed';
  activation.event.id = String(closureData['operationId']);
  saved.activation = { ...saved.activation, operationId: activation.event.id,
    generation: 3, reason: 'bearer_rotation', expectedSequence: closed.sequence };
  activation.event.data = saved;
  expect(foldConnection([...rows, activation]).status).toBe('unavailable');
}

async function saveUsesCleanupLock() {
  await joinMember('save-lock');
  const test = fixture('save-lock', pgDb(storage.queue));
  const profile = { siloId: 'test', userId: 'save-lock', serverId: 'server',
    profileId: test.input.profileId };
  const staged = vi.spyOn(test.custody, 'stage');
  async function cleanupInProgress() {
    await expect(test.save()).rejects.toThrow('Connection coordination unavailable');
    expect(staged).not.toHaveBeenCalled();
  }
  await withConnectionStage(pgDb(storage.queue), profile, cleanupInProgress);
  expect(await nats.store.head(test.subject)).toBe(0);
  expect((await test.save()).status).toBe('saved_unverified');
}
it('refuses staging while another worker holds the cleanup lock', saveUsesCleanupLock);
