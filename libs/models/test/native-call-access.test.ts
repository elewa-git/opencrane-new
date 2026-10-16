import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { tokenVerifier } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { admitDescendant, descendantId, history } from '../src/index.ts';
import { checkNativeCall } from '../src/native-call-check.ts';
import { parseTurnToken } from '../src/decision-turn-token.ts';
import { fixture } from './fixture.ts';

type Context = Awaited<ReturnType<typeof fixture>>;
const disabled = 'Native delegation is disabled';
const scopes = { models: ['gpt-6.1-sol'], tools: [], resources: [], operations: [],
  destinations: [], connectionIds: [], profileIds: [] };
const root = { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'root-turn', threadId: 'root-thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default', executionMode: 'memory_free', model: 'gpt-6.1-sol',
  providerId: 'provider', bindingSequence: 1, sharingClass: undefined as string | undefined };
const sharedRoot = { ...root, conversationId: 'child', payingGroupId: 'sales',
  executionMode: 'restricted', sharingClass: 'shared_only' };
function child(start: typeof root, name: string,
  parent?: { delegationId: string; turnId: string; threadId: string }) {
  const binding = { ...start, task: 'native_descendant', generation: 1,
    dataClass: start.sharingClass ? 'shared' : 'private', scopes, rootId: 'root',
    rootTurnId: start.turnId, rootThreadId: start.threadId, delegationId: '',
    parentTurnId: parent?.turnId ?? start.turnId,
    parentThreadId: parent?.threadId ?? start.threadId,
    turnId: `turn-${name}`, threadId: `thread-${name}`, spawnItemId: `spawn-${name}`,
    ...(parent ? { parentDelegationId: parent.delegationId } : {}) };
  binding.delegationId = descendantId('test', binding);
  return binding;
}
async function admit(context: Context, binding: ReturnType<typeof child>) {
  const claims = { jti: binding.delegationId, typ: 'descendant-admission', silo: 'test', binding };
  const signed = await context.sign(claims, 'delegation-admission');
  const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
  await admitDescendant(context.nats.store, context.binding, verifier, signed);
}
async function admitPair(context: Context, start: typeof root) {
  await context.append('computer-assistant', 'computer.turn_started', start);
  const first = child(start, 'first');
  const second = child(start, 'second', first);
  await admit(context, first);
  await admit(context, second);
  return [first, second];
}
async function sharedSetup(context: Context) {
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
      requestId: 'request', firstInputId: 'root-turn' } };
  await context.append('conversation-child', 'conversation.created', chat);
  return admitPair(context, sharedRoot);
}
function claims(context: Context, binding: ReturnType<typeof child>) {
  const delegation = ['alice'];
  if (binding.parentDelegationId) delegation.push(binding.parentDelegationId);
  delegation.push(binding.delegationId);
  return { ...context.t, task: binding.task, turn: binding.turnId, thread: binding.threadId,
    conversation: binding.conversationId, sharingClass: binding.sharingClass,
    providerId: binding.providerId, bindingSequence: binding.bindingSequence, delegation };
}
async function directCheck(context: Context, fields: Record<string, unknown>) {
  const turn = parseTurnToken({ iat: 1, exp: 121, ...fields });
  const computer = { assistant: 'assistant', computer: 'computer', generation: 1 };
  const checked = await context.credentials.check(context.headers);
  const started = performance.now();
  return checkNativeCall(context.nats.store, context.binding, computer, turn, checked.sequence,
    started, started + 2000);
}
async function checkRoutes(context: Context, fields: Record<string, unknown>, expected: string) {
  const position = await context.nats.store.head('budget-test');
  const check = vi.spyOn(context.actor, 'checkBudget');
  const reserve = vi.spyOn(context.actor, 'reserve');
  const dispatch = vi.spyOn(context.actor, 'admitDispatch');
  const reads = vi.spyOn(context.nats.store, 'readStream');
  const signed = await context.sign(fields, 'decision-service');
  const headers = { ...context.headers, 'x-turn-token': signed,
    'session-id': String(fields['thread']) };
  // Use invalid JSON to prove refusal happens before the request body is parsed.
  const options = { method: 'POST', headers, body: 'not json' };
  const schema = z.object({ error: z.string(), requestId: z.string() });
  try {
    for (const path of ['/authorize', '/authorize/mcp/fixture/installed',
      '/authorize/mcp/memory/server']) {
      const response = await fetch(`${context.options.decisionUrl}${path}`, options);
      expect(response.status).toBe(403);
      const result = schema.parse(await response.json());
      expect(result.error).toBe(expected);
      const rows = await history(context.nats.store, `decision-${result.requestId}`, 'test');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event.data).toMatchObject({ outcome: 'deny' });
    }
    for (const [subject] of reads.mock.calls) {
      expect(subject).not.toMatch(/^(mcp|approval)-/u);
    }
    expect(check).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await context.nats.store.head('budget-test')).toBe(position);
    expect(context.actor.state.reservations).toHaveLength(0);
    expect(context.actor.state.dispatches).toHaveLength(0);
    expect(context.received()).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
}
async function revokedModel() {
  const context = await fixture(2000, 20000, false, root.model);
  try {
    const children = await admitPair(context, root);
    await context.stopDispatch();
    const revoke = { resourceType: 'model', resourceId: root.model,
      granteeId: 'alice', granteeKind: 'member', revokedBy: 'alice' };
    const saved = await context.append(grantStream('model', root.model), 'grant.revoked', revoke);
    expect(await context.auth.applied(saved.id)).toBe(false);
    expect((await context.auth.use('person', 'alice', 'model', root.model)).allowed).toBe(true);
    for (const binding of children) {
      const fields = claims(context, binding);
      await expect(directCheck(context, fields)).rejects.toThrow(/^IAM projection behind$/u);
      await checkRoutes(context, fields, 'Request refused or decision service unavailable');
    }
  } finally {
    await context.close();
  }
}
it('refuses inherited model revocation at both depths while OpenFGA still allows', revokedModel);

async function savedPayer() {
  const context = await fixture(2000, 20000, false, root.model);
  try {
    for (const teamId of ['sales', 'other']) {
      const team = { teamId, name: teamId, createdBy: 'alice' };
      const membership = { teamId, memberId: 'alice', addedBy: 'alice' };
      await context.append(`team-${teamId}`, 'team.created', team);
      await context.append(`team-${teamId}`, 'team.member_added', membership);
    }
    const paidRoot = { ...root, payingGroupId: 'sales' };
    const children = await admitPair(context, paidRoot);
    for (const binding of children) await checkRoutes(context, claims(context, binding), disabled);
    await context.stopDispatch();
    const removal = { teamId: 'sales', memberId: 'alice', removedBy: 'alice' };
    await context.append('team-sales', 'team.member_removed', removal);
    expect((await context.auth.team('alice', 'sales')).allowed).toBe(true);
    expect((await context.auth.team('alice', 'other')).allowed).toBe(true);
    const reason = 'Paying group unavailable or spending permission refused';
    for (const binding of children) {
      const fields = claims(context, binding);
      await expect(directCheck(context, fields)).rejects.toThrow(reason);
      await checkRoutes(context, fields, reason);
    }
  } finally {
    await context.close();
  }
}
it('checks only the saved team payer for a private child of a personal assistant', savedPayer);

async function sharedCalls(change: string) {
  const context = await fixture(2000, 20000, false, root.model, true);
  try {
    const children = await sharedSetup(context);
    await context.stopDispatch();
    for (const binding of children) await checkRoutes(context, claims(context, binding), disabled);
    if (change === 'valid') return;
    if (change === 'parent removal' || change === 'parent rejoin') {
      const removal = { conversationId: 'parent', participantId: 'alice', removedBy: 'alice' };
      await context.append('participation-parent', 'participant.removed', removal);
      if (change === 'parent rejoin') {
        const rejoin = { conversationId: 'parent', participantId: 'alice', addedBy: 'alice' };
        await context.append('participation-parent', 'participant.added', rejoin);
      }
    }
    if (change === 'child closure') {
      const closed = { conversationId: 'child', closedBy: 'alice' };
      await context.append('participation-child', 'conversation.closed', closed);
    }
    expect((await context.auth.conversation('alice', 'child', 'post')).allowed).toBe(true);
    for (const binding of children) {
      const fields = claims(context, binding);
      if (change === 'missing sharing class') fields.sharingClass = undefined;
      let reason = 'Shared participation refused';
      if (change === 'child closure') reason = 'Root is not active';
      if (change === 'missing sharing class') reason = 'Descendant claim refused';
      await expect(directCheck(context, fields)).rejects.toThrow(reason);
      await checkRoutes(context, fields, 'Request refused or decision service unavailable');
    }
    if (change === 'parent rejoin') {
      const removal = { conversationId: 'child', participantId: 'alice', removedBy: 'alice',
        contextKind: 'shared_child', reviewPosition: 1 };
      await context.append('participation-child', 'participant.removed', removal);
      const explicit = { conversationId: 'child', participantId: 'alice', addedBy: 'alice',
        contextKind: 'shared_child', joinKind: 'explicit_child', reviewPosition: 1 };
      const joined = await context.append('participation-child', 'participant.added', explicit);
      await context.auth.handler.handle(joined, context.db);
      for (const binding of children) await checkRoutes(context, claims(context, binding), disabled);
    }
  } finally {
    await context.close();
  }
}
it.each(['valid', 'parent removal', 'child closure', 'missing sharing class', 'parent rejoin'])(
  'checks shared chains at both depths on every route: %s', sharedCalls);

async function removedDuringAccess() {
  const context = await fixture(2000, 20000, false, root.model, true);
  try {
    const children = await sharedSetup(context);
    await context.stopDispatch();
    const original = context.nats.store.readStream.bind(context.nats.store);
    let removed = false;
    async function* readStream(...args: Parameters<typeof original>) {
      yield* original(...args);
      if (args[0] === 'team-sales' && !removed) {
        removed = true;
        const removal = { conversationId: 'parent', participantId: 'alice', removedBy: 'alice' };
        await context.append('participation-parent', 'participant.removed', removal);
      }
    }
    vi.spyOn(context.nats.store, 'readStream').mockImplementation(readStream);
    const fields = claims(context, children[0]!);
    await expect(directCheck(context, fields)).rejects.toThrow('Shared participation refused');
    expect(removed).toBe(true);
    expect((await context.auth.conversation('alice', 'child', 'post')).allowed).toBe(true);
    await checkRoutes(context, fields, 'Request refused or decision service unavailable');
  } finally {
    vi.restoreAllMocks();
    await context.close();
  }
}
it('rechecks shared participation after it changes during the access check', removedDuringAccess);
