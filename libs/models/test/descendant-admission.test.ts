import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { jetstreamManager } from '@nats-io/jetstream';
import { delegations } from '@opencrane/projections';
import { computerTurnStartedDataSchema, parseEventByType } from '@opencrane/events';
import { tokenVerifier } from '@opencrane/auth';
import { createEventStore, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { grantStream } from '@opencrane/authz';
import { admitDescendant, descendantId, history, readDescendantAgreement } from '../src/index.ts';
import { fixture } from './fixture.ts';

type Context = Awaited<ReturnType<typeof fixture>>;
const scopes = { models: ['gpt-6.1-sol'], tools: [], resources: [], operations: [],
  destinations: [], connectionIds: [], profileIds: [] };
function child(name: string, parent?: ReturnType<typeof childBinding>) {
  return childBinding(name, parent);
}
function childBinding(name: string, parent?: { delegationId: string; turnId: string;
  threadId: string }) {
  const binding = { delegationId: '', rootId: 'root', rootTurnId: 'bound-root',
    rootThreadId: 'bound-thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
    conversationId: 'conversation', requesterId: 'alice', payingGroupId: 'personal-default',
    parentTurnId: parent?.turnId ?? 'bound-root', parentThreadId: parent?.threadId ?? 'bound-thread',
    turnId: `turn-${name}`, threadId: `thread-${name}`, spawnItemId: `spawn-${name}`,
    dataClass: 'private' as const, scopes, task: 'native_descendant' as const,
    model: 'gpt-6.1-sol', providerId: 'provider', bindingSequence: 1,
    executionMode: 'memory_free' as const,
    ...(parent ? { parentDelegationId: parent.delegationId } : {}) };
  binding.delegationId = descendantId('test', binding);
  return binding;
}
async function proof(context: Context,
  binding: Parameters<typeof descendantId>[1] & { delegationId: string }) {
  binding.delegationId = descendantId('test', binding);
  const claims = { jti: binding.delegationId, typ: 'descendant-admission', silo: 'test', binding };
  return context.sign(claims, 'delegation-admission');
}
async function admit(context: Context, binding: ReturnType<typeof child>,
  store = context.nats.store) {
  const decision = await proof(context, binding);
  const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
  return admitDescendant(store, context.binding, verifier, decision);
}
async function setup() {
  const context = await fixture(2000, 20000, false, 'gpt-6.1-sol');
  await context.append('computer-assistant', 'computer.turn_started', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: 'bound-root', threadId: 'bound-thread', requesterId: 'alice', task: 'chat_turn',
    payingGroupId: 'personal-default', executionMode: 'memory_free',
    model: 'gpt-6.1-sol', providerId: 'provider', bindingSequence: 1 });
  return context;
}
async function assertNoEffects(context: Context) {
  expect(context.actor.state.reservations).toHaveLength(0);
  expect(context.received()).toBe(0);
  const input = { assistantId: 'assistant', conversationId: 'conversation', turnId: 'turn-child',
    threadId: 'thread-child', requesterId: 'alice', task: 'native_descendant',
    model: 'gpt-6.1-sol' };
  await expect(context.credentials.turn(input)).rejects.toThrow('Native delegation is disabled');
}
async function serialisesReplicaAdmissions() {
  const context = await setup();
  try {
    const other = await createEventStore(await context.nats.client('command'));
    const attempts = [];
    for (let index = 0; index < 6; index++) {
      const store = index % 2 === 0 ? context.nats.store : other;
      attempts.push(admit(context, child(`race-${index}`), store));
    }
    const results = await Promise.allSettled(attempts);
    function admitted(result: PromiseSettledResult<unknown>) {
      return result.status === 'fulfilled';
    }
    expect(results.filter(admitted)).toHaveLength(4);
    const rows = await history(other, 'computer-assistant', 'test');
    function native(row: (typeof rows)[number]) {
      const start = computerTurnStartedDataSchema.safeParse(row.event.data);
      return row.event.type === 'computer.turn_started' && start.success &&
        start.data.task === 'native_descendant';
    }
    expect(rows.filter(native)).toHaveLength(4);
    const successfulIndex = results.findIndex(admitted);
    const first = child(`race-${successfulIndex}`);
    const original = results[successfulIndex];
    if (original?.status !== 'fulfilled') {
      throw new Error('Missing successful admission');
    }
    const saved = await admit(context, first);
    expect(saved).toEqual(original.value);
    expect(await admit(context, first, other)).toEqual(saved);
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('admits at most four descendants across competing replicas and keeps retries unchanged',
  serialisesReplicaAdmissions);

async function refusesConcurrentChangedRetry() {
  const context = await setup();
  try {
    const other = await createEventStore(await context.nats.client('command'));
    const narrow = { ...child('same-id'), scopes: { ...scopes, models: [] } };
    const wider = child('same-id');
    expect(narrow.delegationId).toBe(wider.delegationId);
    const ready = Promise.withResolvers<void>();
    let waiting = 0;
    function competingStore(store: EventStore): EventStore {
      const originalAppend = store.append.bind(store);
      async function append(command: Parameters<EventStore['append']>[0]) {
        waiting++;
        if (waiting === 2) {
          ready.resolve();
        }
        // Let both replicas validate the same position before either writes.
        await ready.promise;
        return originalAppend(command);
      }
      store.append = append;
      return store;
    }
    const firstStore = competingStore(context.nats.store);
    const secondStore = competingStore(other);
    const attempts = [admit(context, narrow, firstStore), admit(context, wider, secondStore)];
    const results = await Promise.allSettled(attempts);
    function admitted(result: PromiseSettledResult<unknown>) {
      return result.status === 'fulfilled';
    }
    function refused(result: PromiseSettledResult<unknown>) {
      return result.status === 'rejected';
    }
    const accepted = results.filter(admitted);
    const rejected = results.filter(refused);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const expectedRefusal = { reason: new Error('Admission conflict') };
    expect(rejected[0]).toMatchObject(expectedRefusal);
    const rows = await history(other, 'computer-assistant', 'test');
    function sameAdmission(row: (typeof rows)[number]) {
      return row.event.id === narrow.delegationId;
    }
    const saved = rows.filter(sameAdmission);
    expect(saved).toHaveLength(1);
    const original = saved[0]!;
    const expectedAcceptance = { value: { admission: original } };
    expect(accepted[0]).toMatchObject(expectedAcceptance);
    const originalBinding = computerTurnStartedDataSchema.parse(original.event.data);
    if (originalBinding.task !== 'native_descendant') {
      throw new Error('Saved admission is not a native descendant');
    }
    const unchanged = originalBinding.scopes.models.length === 0 ? narrow : wider;
    const changed = unchanged === narrow ? wider : narrow;
    expect((await admit(context, unchanged, other)).admission).toEqual(original);
    await expect(admit(context, changed)).rejects.toThrow('Admission conflict');
    const finalRows = await history(other, 'computer-assistant', 'test');
    expect(finalRows.filter(sameAdmission)).toEqual(saved);
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('refuses a concurrent changed retry and returns the stored original on identical retry',
  refusesConcurrentChangedRetry);

const invalidBindings = [
  { executionMode: 'restricted' }, { providerId: 'other' }, { bindingSequence: 2 },
  { model: 'gpt-6-astra' }, { computerId: 'other' }, { conversationId: 'other' },
  { parentTurnId: 'foreign' }, { parentThreadId: 'foreign' }, { generation: 2 },
  { requesterId: 'bob' }, { payingGroupId: 'other' }, { rootThreadId: 'foreign' },
  { turnId: 'bound-root' }, { threadId: 'bound-thread' }, { dataClass: 'shared' },
  { scopes: { ...scopes, models: ['gpt-6-astra'] } },
  { scopes: { ...scopes, tools: ['shell'] } },
  { scopes: { ...scopes, resources: ['private-file'] } },
  { scopes: { ...scopes, operations: ['write'] } },
  { scopes: { ...scopes, destinations: ['example.test'] } },
  { scopes: { ...scopes, connectionIds: ['connection'] } },
  { scopes: { ...scopes, profileIds: ['profile'] } },
];
async function refusesChangedBindings() {
  const context = await setup();
  const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
  try {
    for (const patch of invalidBindings) {
      const binding = { ...child('refused'), ...patch };
      const decision = await proof(context, binding);
      const position = await context.nats.store.head('computer-assistant');
      await expect(admitDescendant(context.nats.store, context.binding, verifier, decision))
        .rejects.toThrow();
      expect(await context.nats.store.head('computer-assistant')).toBe(position);
    }
    const parent = { ...child('narrow-parent'), scopes: { ...scopes, models: [] } };
    await admit(context, parent);
    await expect(admit(context, child('wider-grandchild', parent)))
      .rejects.toThrow('Descendant scope refused');
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('refuses cycles, foreign parents, changed identities and every wider scope',
  refusesChangedBindings);

async function refusesUnsignedOrForgedDecisions() {
  const context = await setup();
  const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
  try {
    const signed = await proof(context, child('signed'));
    const segments = signed.split('.');
    const claims = Buffer.from(JSON.stringify({ typ: 'descendant-admission', silo: 'test',
      binding: child('forged') })).toString('base64url');
    const forged = `${segments[0]}.${claims}.${segments[2]}`;
    const decisions = [JSON.stringify(child('unsigned')), forged, context.headers['x-turn-token']];
    for (const decision of decisions) {
      await expect(admitDescendant(context.nats.store, context.binding, verifier, decision))
        .rejects.toThrow();
    }
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('refuses unsigned, forged and ordinary turn decisions', refusesUnsignedOrForgedDecisions);

async function refusesInheritedRevocation() {
  const context = await setup();
  try {
    const parent = child('parent');
    await admit(context, parent);
    await context.append(grantStream('model', 'gpt-6.1-sol'), 'grant.revoked', {
      resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'member',
      granteeId: 'alice', revokedBy: 'alice' });
    const staleGrant = await context.auth.use('person', 'alice', 'model', 'gpt-6.1-sol');
    expect(staleGrant.allowed).toBe(true);
    await expect(admit(context, child('grandchild', parent))).rejects.toThrow('IAM projection behind');
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('refuses inherited revocation while OpenFGA still allows the parent grant',
  refusesInheritedRevocation);

async function closeChild(context: Context, binding: ReturnType<typeof child>) {
  const event = { id: `close-${binding.turnId}`, commandId: `close-${binding.turnId}`,
    subject: 'computer-assistant', type: 'computer.turn_closed', silo: 'test',
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'opencrane-server' },
    time: new Date().toISOString(), correlation: {}, data: { ...binding, status: 'completed' } };
  await context.nats.seed([event]);
}
async function keepsLifetimeAndDepthLimits() {
  const context = await setup();
  try {
    const parent = child('parent');
    await admit(context, parent);
    const grandchild = child('grandchild', parent);
    await admit(context, grandchild);
    await expect(admit(context, child('too-deep', grandchild))).rejects.toThrow();
    await closeChild(context, grandchild);
    for (let index = 0; index < 3; index++) {
      const next = child(`grandchild-${index}`, parent);
      await admit(context, next);
      await closeChild(context, next);
    }
    await expect(admit(context, child('fifth-child', parent))).rejects.toThrow();
    await closeChild(context, parent);
    await expect(admit(context, child('ended-parent', parent))).rejects.toThrow();
    const secondParent = child('second-parent');
    await admit(context, secondParent);
    for (let index = 0; index < 2; index++) {
      const next = child(`second-child-${index}`, secondParent);
      await admit(context, next);
      await closeChild(context, next);
    }
    await expect(admit(context, child('ninth', secondParent)))
      .rejects.toThrow('Descendant limit reached');
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('counts ended admissions towards lifetime and parent limits and refuses a third level',
  keepsLifetimeAndDepthLimits);

async function refusesDuplicateBindingsAndActiveOverflow() {
  const context = await setup();
  try {
    const parent = child('parent');
    const sibling = child('sibling');
    await admit(context, parent);
    await admit(context, sibling);
    const grandchild = child('grandchild', parent);
    await admit(context, grandchild);
    await admit(context, child('other-grandchild', parent));
    await expect(admit(context, child('active-overflow', sibling)))
      .rejects.toThrow('Descendant limit reached');
    await closeChild(context, grandchild);
    await admit(context, child('replacement', sibling));
    for (const patch of [{ threadId: parent.threadId }, { turnId: parent.turnId },
      { spawnItemId: parent.spawnItemId }, { rootId: 'other-root' }]) {
      await expect(admit(context, { ...child('duplicate'), ...patch })).rejects.toThrow();
    }
    await expect(admit(context, { ...parent, scopes: { ...scopes, models: [] } }))
      .rejects.toThrow('Admission conflict');
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('refuses duplicate bindings and counts active grandchildren across parents',
  refusesDuplicateBindingsAndActiveOverflow);

async function recordsSeparateStart() {
  const context = await setup();
  try {
    const budgetPosition = await context.nats.store.head('budget-test');
    const binding = child('record');
    const result = await admit(context, binding);
    const admissions = await history(context.nats.store, 'computer-assistant', 'test');
    const admission = admissions.at(-1)!;
    const starts = await history(context.nats.store, `delegation-${binding.delegationId}`, 'test');
    expect(starts).toHaveLength(1);
    const start = starts[0]!;
    expect(result).toEqual({ admission, start });
    expect(start.event.type).toBe('delegation.started');
    expect(start.event.data).toEqual({
      version: 1, delegationId: binding.delegationId, rootId: 'root', rootTurnId: 'bound-root',
      rootThreadId: 'bound-thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
      conversationId: 'conversation', requesterId: 'alice', payingGroupId: 'personal-default',
      parentTurnId: 'bound-root', parentThreadId: 'bound-thread', turnId: 'turn-record',
      threadId: 'thread-record', spawnItemId: 'spawn-record', dataClass: 'private',
      scopes: { models: ['gpt-6.1-sol'], tools: [], resources: [], operations: [],
        destinations: [], connectionIds: [], profileIds: [] },
      computerAdmission: { eventId: admission.event.id, position: admission.sequence },
    });
    const position = await context.nats.store.head();
    await context.runner.initialise(delegations);
    await context.runner.run(delegations);
    await context.runner.rebuild(delegations);
    await context.runner.run(delegations);
    expect(await context.nats.store.head()).toBe(position);
    expect(await context.nats.store.head('budget-test')).toBe(budgetPosition);
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('records a separate versioned start with the exact saved computer admission',
  recordsSeparateStart);

function loseReply(store: EventStore, type: string) {
  const original = store.append.bind(store);
  async function append(command: Parameters<EventStore['append']>[0]) {
    const saved = await original(command);
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === type) {
      store.append = original;
      return { status: 'unavailable' as const, cause: new Error('Reply lost') };
    }
    return saved;
  }
  store.append = append;
}

async function recoversLostReply(type: string) {
  const context = await setup();
  try {
    const manager = await jetstreamManager(context.nats.connection);
    const config = { duplicate_window: 1_000_000_000 };
    await manager.streams.update('EVENTS', config);
    const binding = child('lost');
    const decision = await proof(context, binding);
    const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
    loseReply(context.nats.store, type);
    await expect(admitDescendant(context.nats.store, context.binding, verifier, decision))
      .rejects.toThrow('unavailable');
    const before = await context.nats.store.head();
    await delay(1100);
    const other = await createEventStore(await context.nats.client('command'));
    const result = await admitDescendant(other, context.binding, verifier, decision);
    const expectedNewEvents = type === 'computer.turn_started' ? 1 : 0;
    expect(await other.head()).toBe(before + expectedNewEvents);
    const computerRows = await history(other, 'computer-assistant', 'test');
    const starts = await history(other, `delegation-${binding.delegationId}`, 'test');
    expect(result.admission).toEqual(computerRows.at(-1));
    expect(starts).toEqual([result.start]);
    expect(await admitDescendant(other, context.binding, verifier, decision)).toEqual(result);
    expect(await other.head()).toBe(before + expectedNewEvents);
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it.each(['computer.turn_started', 'delegation.started'])(
  'recovers a lost %s reply beyond the duplicate window with the same signed decision',
  recoversLostReply);

async function racesOneStart() {
  const context = await setup();
  try {
    const binding = child('same-start');
    loseReply(context.nats.store, 'computer.turn_started');
    await expect(admit(context, binding)).rejects.toThrow('unavailable');
    const other = await createEventStore(await context.nats.client('command'));
    const ready = Promise.withResolvers<void>();
    let waiting = 0;
    function competingStore(store: EventStore) {
      const original = store.append.bind(store);
      async function append(command: Parameters<EventStore['append']>[0]) {
        expect(command.expectedSequence).toBe(0);
        waiting++;
        if (waiting === 2) {
          ready.resolve();
        }
        await ready.promise;
        return original(command);
      }
      store.append = append;
      return store;
    }
    const firstStore = competingStore(context.nats.store);
    const secondStore = competingStore(other);
    const attempts = [admit(context, binding, firstStore), admit(context, binding, secondStore)];
    const results = await Promise.all(attempts);
    expect(results[0]).toEqual(results[1]);
    const starts = await history(other, `delegation-${binding.delegationId}`, 'test');
    expect(starts).toEqual([results[0]!.start]);
  } finally {
    await context.close();
  }
}
it('saves one start when two replicas race and returns that stored start to both', racesOneStart);

async function seedAdmission(context: Context, binding: ReturnType<typeof child>) {
  const event = { id: binding.delegationId, commandId: binding.delegationId,
    subject: 'computer-assistant', type: 'computer.turn_started', silo: 'test',
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'opencrane-server' },
    time: new Date().toISOString(), correlation: {}, data: binding };
  await context.nats.seed([event]);
  const rows = await history(context.nats.store, 'computer-assistant', 'test');
  return rows.at(-1)!;
}
function startData(binding: ReturnType<typeof child>, admission: StoredEvent) {
  const { task, model, providerId, bindingSequence, executionMode, ...fields } = binding;
  return { ...fields, version: 1,
    computerAdmission: { eventId: admission.event.id, position: admission.sequence } };
}
async function seedStart(context: Context, binding: ReturnType<typeof child>, data: unknown) {
  const id = `delegation-start:${binding.delegationId}`;
  const event = { id, commandId: id, subject: `delegation-${binding.delegationId}`,
    type: 'delegation.started', silo: 'test', source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    time: new Date().toISOString(), correlation: {}, data };
  await context.nats.seed([event]);
}

async function refusesConflictingStarts() {
  const context = await setup();
  try {
    await context.stopDispatch();
    const sample = child('example');
    const sampleAdmission = await seedAdmission(context, sample);
    const example = startData(sample, sampleAdmission);
    const patches: Record<string, unknown>[] = [];
    for (const [field, value] of Object.entries(example)) {
      if (typeof value === 'string') {
        patches.push({ [field]: field === 'dataClass' ? 'shared' : `other-${value}` });
      }
    }
    patches.push({ generation: 2 }, { parentDelegationId: 'other-parent' },
      { computerAdmission: { eventId: 'wrong', position: 1 } });
    for (const field of Object.keys(scopes)) {
      patches.push({ scopes: { ...scopes, [field]: ['other'] } });
    }
    for (const [index, patch] of patches.entries()) {
      const binding = child(`conflict-${index}`);
      const admission = await seedAdmission(context, binding);
      const data = { ...startData(binding, admission), ...patch };
      if ('computerAdmission' in patch) {
        data.computerAdmission = { eventId: 'wrong', position: admission.sequence };
      }
      await seedStart(context, binding, data);
      const position = await context.nats.store.head();
      await expect(admit(context, binding)).rejects.toThrow('Admission conflict');
      await expect(readDescendantAgreement(context.nats.store, 'test', 'assistant',
        binding.delegationId)).rejects.toThrow('Admission conflict');
      expect(await context.nats.store.head()).toBe(position);
    }
    const binding = child('wrong-position');
    const admission = await seedAdmission(context, binding);
    const data = { ...startData(binding, admission),
      computerAdmission: { eventId: admission.event.id, position: admission.sequence + 1 } };
    await seedStart(context, binding, data);
    await expect(admit(context, binding)).rejects.toThrow('Admission conflict');
    await expect(readDescendantAgreement(context.nats.store, 'test', 'assistant',
      binding.delegationId)).rejects.toThrow('Admission conflict');
    const legacy = child('legacy');
    await seedAdmission(context, legacy);
    const oldData = { delegationId: legacy.delegationId, parentComputerId: 'computer',
      childComputerId: 'other', rootBudgetId: 'root' };
    await seedStart(context, legacy, oldData);
    await expect(admit(context, legacy)).rejects.toThrow('Admission conflict');
    await expect(readDescendantAgreement(context.nats.store, 'test', 'assistant',
      legacy.delegationId)).rejects.toThrow('Admission conflict');
  } finally {
    await context.close();
  }
}
it('refuses every changed binding, wrong admission reference and legacy start without writing',
  refusesConflictingStarts);

async function readsAgreementWithoutEffects() {
  const context = await setup();
  try {
    const binding = child('agreement');
    await seedAdmission(context, binding);
    const before = await context.nats.store.head();
    await expect(readDescendantAgreement(context.nats.store, 'test', 'assistant',
      binding.delegationId)).rejects.toThrow();
    expect(await context.nats.store.head()).toBe(before);
    const pair = await admit(context, binding);
    expect(await readDescendantAgreement(context.nats.store, 'test', 'assistant',
      binding.delegationId)).toEqual(pair);
    const other = await createEventStore(await context.nats.client('command'));
    expect(await readDescendantAgreement(other, 'test', 'assistant', binding.delegationId))
      .toEqual(pair);
    await closeChild(context, binding);
    await expect(readDescendantAgreement(other, 'test', 'assistant', binding.delegationId))
      .rejects.toThrow('closed');
    await expect(admit(context, binding)).rejects.toThrow('closed');
    await assertNoEffects(context);
  } finally {
    await context.close();
  }
}
it('reads only matching records and refuses a missing start or closed computer admission',
  readsAgreementWithoutEffects);

async function refusesUnavailableRead(subject: string) {
  const context = await setup();
  try {
    const binding = child('unavailable');
    await admit(context, binding);
    const original = context.nats.store.readStream.bind(context.nats.store);
    function readStream(...args: Parameters<EventStore['readStream']>) {
      if (args[0].startsWith(subject)) {
        throw new Error('Unavailable read containing private binding values');
      }
      return original(...args);
    }
    context.nats.store.readStream = readStream;
    await expect(readDescendantAgreement(context.nats.store, 'test', 'assistant',
      binding.delegationId)).rejects.toThrow(/^Delegation agreement unavailable$/u);
  } finally {
    await context.close();
  }
}
it.each(['computer-', 'delegation-'])('refuses an unavailable %s read without binding values',
  refusesUnavailableRead);
