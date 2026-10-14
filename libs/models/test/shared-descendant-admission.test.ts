import { expect, it } from 'vitest';
import { tokenVerifier } from '@opencrane/auth';
import { createEventStore } from '@opencrane/event-store';
import { admitDescendant, descendantId, history, readDescendantAgreement } from '../src/index.ts';
import { fixture } from './fixture.ts';

type Context = Awaited<ReturnType<typeof setup>>;
const scopes = { models: ['gpt-6.1-sol'], tools: [], resources: [], operations: [],
  destinations: [], connectionIds: [], profileIds: [] };
const root = { assistantId: 'assistant', computerId: 'computer', conversationId: 'child',
  turnId: 'root-turn', threadId: 'root-thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'sales', executionMode: 'restricted', sharingClass: 'shared_only',
  model: 'gpt-6.1-sol', providerId: 'provider', bindingSequence: 1 };

async function setup(rootPatch: Record<string, unknown> = {},
  chatPatch: Record<string, unknown> = {}) {
  const context = await fixture(2000, 20000, false, 'gpt-6.1-sol', true);
  const parent = { conversationId: 'parent', createdBy: 'alice', mode: 'group',
    participantIds: ['alice', 'bob'] };
  const created = await context.append('conversation-parent', 'conversation.created', parent);
  const position = await context.nats.store.head('conversation-parent');
  const chat = { conversationId: 'child', createdBy: 'alice', mode: 'agent_session',
    contextKind: 'shared_child', assistantId: 'assistant', payingGroupId: 'sales',
    initialJoins: [{ participantId: 'alice', parentJoinEventId: created.id,
      parentJoinPosition: position }],
    origin: { parentConversationId: 'parent', sourceMessageId: 'source',
      sourcePosition: position + 1, intentEventId: 'intent', intentPosition: position + 2,
      requestId: 'request', firstInputId: 'root-turn' }, ...chatPatch };
  for (const [field, value] of Object.entries(chatPatch)) {
    if (value === undefined) Reflect.deleteProperty(chat, field);
  }
  await context.append('conversation-child', 'conversation.created', chat);
  const start = { ...root, ...rootPatch };
  await context.append('computer-assistant', 'computer.turn_started', start);
  return context;
}
function child(name: string, parent?: ReturnType<typeof childBinding>) {
  return childBinding(name, parent);
}
function childBinding(name: string, parent?: { delegationId: string; turnId: string;
  threadId: string }) {
  return { ...root, task: 'native_descendant', generation: 1, dataClass: 'shared', scopes,
    rootId: 'root', rootTurnId: root.turnId, rootThreadId: root.threadId,
    delegationId: '', parentTurnId: parent?.turnId ?? root.turnId,
    parentThreadId: parent?.threadId ?? root.threadId,
    turnId: `turn-${name}`, threadId: `thread-${name}`, spawnItemId: `spawn-${name}`,
    ...(parent ? { parentDelegationId: parent.delegationId } : {}) };
}
async function admit(context: Context, binding: ReturnType<typeof child>,
  store = context.nats.store) {
  binding.delegationId = descendantId('test', binding);
  const claims = { jti: binding.delegationId, typ: 'descendant-admission', silo: 'test', binding };
  const decision = await context.sign(claims, 'delegation-admission');
  const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
  return admitDescendant(store, context.binding, verifier, decision);
}
async function noEffects(context: Context, budgetPosition: number) {
  expect(await context.nats.store.head('budget-test')).toBe(budgetPosition);
  expect(context.actor.state.reservations).toHaveLength(0);
  expect(context.received()).toBe(0);
}
async function admitsSharedChildren() {
  const context = await setup();
  try {
    const budgetPosition = await context.nats.store.head('budget-test');
    const parent = child('parent');
    const saved = await admit(context, parent);
    expect(saved.admission.event.data).toEqual(parent);
    const agreement = await readDescendantAgreement(context.nats.store, 'test', 'assistant',
      parent.delegationId);
    expect(agreement).toEqual(saved);
    const expectedClass = { dataClass: 'shared', sharingClass: 'shared_only' };
    expect(saved.start.event.data).toMatchObject(expectedClass);
    const grandchild = child('grandchild', parent);
    grandchild.scopes = { ...scopes, models: [] };
    expect((await admit(context, grandchild)).admission.event.data).toEqual(grandchild);
    await noEffects(context, budgetPosition);
  } finally {
    await context.close();
  }
}
it('copies a shared root into both admission records and narrows a grandchild model scope',
  admitsSharedChildren);

async function refusesChangedBindings() {
  const context = await setup();
  try {
    const parent = child('parent');
    await admit(context, parent);
    const patches: Record<string, unknown>[] = [
      { dataClass: 'private' }, { sharingClass: undefined }, { executionMode: 'memory_free' },
      { payingGroupId: 'personal-default' }, { requesterId: 'bob' }, { providerId: 'other' },
      { bindingSequence: 2 }, { model: 'gpt-6-astra' }, { generation: 2 },
    ];
    for (const field of Object.keys(scopes)) {
      patches.push({ scopes: { ...scopes, [field]: ['other'] } });
    }
    const position = await context.nats.store.head();
    for (const patch of patches) {
      for (const ancestor of [undefined, parent]) {
        const binding = { ...child('refused', ancestor), ...patch };
        await expect(admit(context, binding)).rejects.toThrow();
      }
    }
    expect(await context.nats.store.head()).toBe(position);
  } finally {
    await context.close();
  }
}
it('refuses changed root fields, classes and wider scopes for children and grandchildren',
  refusesChangedBindings);

async function refusesPrivateClassChange() {
  const privateRoot = { sharingClass: undefined, executionMode: 'memory_free' };
  const privateChat = { contextKind: undefined, origin: undefined, initialJoins: undefined };
  const context = await setup(privateRoot, privateChat);
  try {
    const parent = { ...child('private'), ...privateRoot, dataClass: 'private' };
    await admit(context, parent);
    const shared = { ...child('shared'), sharingClass: undefined,
      executionMode: 'memory_free' };
    await expect(admit(context, shared)).rejects.toThrow('Root binding refused');
    const grandchild = { ...child('shared-grandchild', parent), sharingClass: undefined,
      executionMode: 'memory_free' };
    await expect(admit(context, grandchild)).rejects.toThrow('Root binding refused');
  } finally {
    await context.close();
  }
}
it('keeps private children private at both descendant levels', refusesPrivateClassChange);

const invalidRoots = [
  { rootPatch: {}, chatPatch: { contextKind: undefined, origin: undefined,
    initialJoins: undefined } },
  { rootPatch: { sharingClass: undefined }, chatPatch: {} },
  { rootPatch: { executionMode: 'memory_free' }, chatPatch: {} },
  { rootPatch: { payingGroupId: 'other' }, chatPatch: {} },
  { rootPatch: {}, chatPatch: { payingGroupId: 'other' } },
];
async function refusesInvalidRoot(patches: (typeof invalidRoots)[number]) {
  const context = await setup(patches.rootPatch, patches.chatPatch);
  try {
    const binding = { ...child('refused'), ...patches.rootPatch };
    const position = await context.nats.store.head();
    await expect(admit(context, binding)).rejects.toThrow();
    expect(await context.nats.store.head()).toBe(position);
  } finally {
    await context.close();
  }
}
it.each(invalidRoots)('refuses a shared root with invalid chat, class, mode or payer %j',
  refusesInvalidRoot);

const endingEvents = [
  { subject: 'participation-parent', type: 'participant.removed',
    data: { conversationId: 'parent', participantId: 'alice', removedBy: 'alice' } },
  { subject: 'participation-child', type: 'conversation.closed',
    data: { conversationId: 'child', closedBy: 'alice' } },
  { subject: 'conversation-child', type: 'agent.turn_stop_requested',
    data: { conversationId: 'child', turnId: 'root-turn',
      requestedBy: 'alice' } },
  { subject: 'computer-assistant', type: 'computer.turn_closed',
    data: { ...root, status: 'completed' } },
  { subject: 'team-sales', type: 'team.member_removed',
    data: { teamId: 'sales', memberId: 'alice', removedBy: 'alice' } },
];
async function refusesEndedAccess(change: (typeof endingEvents)[number]) {
  const context = await setup();
  try {
    await context.stopDispatch();
    await context.append(change.subject, change.type, change.data);
    const stale = await context.auth.conversation('alice', 'child', 'post');
    expect(stale.allowed).toBe(true);
    const position = await context.nats.store.head();
    await expect(admit(context, child('refused'))).rejects.toThrow();
    expect(await context.nats.store.head()).toBe(position);
  } finally {
    await context.close();
  }
}
it.each(endingEvents)('refuses ended access despite stale OpenFGA allow: $type',
  refusesEndedAccess);

async function racesSharedAdmissions() {
  const context = await setup();
  try {
    const budgetPosition = await context.nats.store.head('budget-test');
    const other = await createEventStore(await context.nats.client('command'));
    const attempts = [];
    for (let index = 0; index < 6; index++) {
      const store = index % 2 === 0 ? context.nats.store : other;
      attempts.push(admit(context, child(`race-${index}`), store));
    }
    const results = await Promise.allSettled(attempts);
    function accepted(result: PromiseSettledResult<unknown>) {
      return result.status === 'fulfilled';
    }
    expect(results.filter(accepted)).toHaveLength(4);
    const rows = await history(other, 'computer-assistant', 'test');
    function native(row: (typeof rows)[number]) {
      return row.event.type === 'computer.turn_started' &&
        Reflect.get(row.event.data as object, 'task') === 'native_descendant';
    }
    expect(rows.filter(native)).toHaveLength(4);
    await noEffects(context, budgetPosition);
  } finally {
    await context.close();
  }
}
it('limits a shared root to four active children across two replicas', racesSharedAdmissions);
