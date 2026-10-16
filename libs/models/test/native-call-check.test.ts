import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { checkNativeCall } from '../src/native-call-check.ts';
import { parseTurnToken } from '../src/decision-turn-token.ts';
import { tokenVerifier } from '@opencrane/auth';
import { createEventStore, type EventStore } from '@opencrane/event-store';
import { admitDescendant, descendantId, history } from '../src/index.ts';
import { fixture } from './fixture.ts';

type Context = Awaited<ReturnType<typeof fixture>>;
const disabled = 'Native delegation is disabled';
const refused = 'Request refused or decision service unavailable';
const responseSchema = z.object({ error: z.string(), requestId: z.string() });
const storedFields = z.record(z.string(), z.unknown());
const scopes = { models: ['gpt-6.1-sol'], tools: [], resources: [], operations: [],
  destinations: [], connectionIds: [], profileIds: [] };
const root = { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'bound-root', threadId: 'bound-thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default', executionMode: 'memory_free', model: 'gpt-6.1-sol',
  providerId: 'provider', bindingSequence: 1 };
function child(name: string, parent?: { delegationId: string; turnId: string; threadId: string }) {
  const binding = { ...root, task: 'native_descendant', delegationId: '', rootId: 'root',
    rootTurnId: root.turnId, rootThreadId: root.threadId, generation: 1,
    parentTurnId: parent?.turnId ?? root.turnId, parentThreadId: parent?.threadId ?? root.threadId,
    turnId: `turn-${name}`, threadId: `thread-${name}`, spawnItemId: `spawn-${name}`,
    dataClass: 'private', scopes,
    ...(parent ? { parentDelegationId: parent.delegationId } : {}) };
  binding.delegationId = descendantId('test', binding);
  return binding;
}
async function admit(context: Context, binding: ReturnType<typeof child>) {
  const claims = { jti: binding.delegationId, typ: 'descendant-admission', silo: 'test', binding };
  const signed = await context.sign(claims, 'delegation-admission');
  const verifier = tokenVerifier(context.identity.jwks, context.identity.issuer);
  return admitDescendant(context.nats.store, context.binding, verifier, signed);
}
async function setup() {
  const context = await fixture(2000, 20000, false, root.model);
  await context.append('computer-assistant', 'computer.turn_started', root);
  return context;
}
function claims(context: Context, binding: ReturnType<typeof child>) {
  const delegation = ['alice'];
  if (binding.parentDelegationId) delegation.push(binding.parentDelegationId);
  delegation.push(binding.delegationId);
  return { ...context.t, task: binding.task, turn: binding.turnId, thread: binding.threadId,
    providerId: binding.providerId, bindingSequence: binding.bindingSequence, delegation };
}
async function request(context: Context, fields: Record<string, unknown>, path = '/authorize') {
  const signed = await context.sign(fields, 'decision-service');
  const headers = { ...context.headers, 'x-turn-token': signed,
    'session-id': String(fields['thread']) };
  // Send invalid JSON so reaching the final refusal proves the body was never parsed.
  const options = { method: 'POST', headers, body: 'not json' };
  const response = await fetch(`${context.options.decisionUrl}${path}`, options);
  expect(response.status).toBe(403);
  const result = responseSchema.parse(await response.json());
  const rows = await history(context.nats.store, `decision-${result.requestId}`, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event.data).toMatchObject({ outcome: 'deny' });
  return result.error;
}
async function noSpending(context: Context, position: number) {
  expect(await context.nats.store.head('budget-test')).toBe(position);
  expect(context.actor.state.reservations).toHaveLength(0);
  expect(context.actor.state.dispatches).toHaveLength(0);
  expect(context.received()).toBe(0);
}

let context: Context;
const first = child('first');
const second = child('second', first);
beforeAll(async function prepare() {
  context = await setup();
  await admit(context, first);
  await admit(context, second);
}, 120_000);
afterAll(async function close() {
  await context.close();
});

async function reachesFinalRefusal(depth: number) {
  const binding = depth === 2 ? first : second;
  const fields = claims(context, binding);
  const position = await context.nats.store.head('budget-test');
  const check = vi.spyOn(context.actor, 'checkBudget');
  const reserve = vi.spyOn(context.actor, 'reserve');
  const dispatch = vi.spyOn(context.actor, 'admitDispatch');
  try {
    for (const path of ['/authorize', '/authorize/mcp/fixture/installed',
      '/authorize/mcp/memory/server']) {
      expect(await request(context, fields, path)).toBe(disabled);
    }
    const signed = await context.sign(fields, 'decision-service');
    const headers = { 'x-turn-token': signed, 'session-id': binding.threadId };
    for (const path of ['/v1/responses', '/mcp/fixture/installed']) {
      const reply = await context.call(headers, {}, path);
      expect(reply.status).toBe(403);
      expect(reply.text).toContain(disabled);
    }
    expect(check).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await noSpending(context, position);
  } finally {
    vi.restoreAllMocks();
  }
}
it.each([2, 3])('checks a saved chain of length %s before the final disabled refusal',
  reachesFinalRefusal);

const changedClaims = [
  ['turn', 'other'], ['thread', 'other'], ['conversation', 'other'], ['requester', 'bob'],
  ['assistant', 'other'], ['model', 'gpt-6-astra'], ['providerId', 'other'],
  ['bindingSequence', 2], ['sharingClass', 'shared_only'],
  ['delegation', ['alice']], ['delegation', ['bob', first.delegationId]],
  ['delegation', ['alice', 'extra', first.delegationId]],
  ['delegation', ['alice', first.delegationId, second.delegationId, 'extra']],
  ['task', 'chat_turn'],
] as const;
async function refusesClaim(field: string, value: unknown) {
  const fields = { ...claims(context, first), [field]: value };
  // Keep the chain valid so this case reaches the saved requester comparison.
  if (field === 'requester') fields.delegation = [String(value), first.delegationId];
  expect(await request(context, fields)).toBe(refused);
  if (field === 'delegation' || field === 'task') {
    await expect(directCheck(fields)).rejects.not.toThrow(disabled);
    return;
  }
  await expect(directCheck(fields)).rejects.toThrow('Descendant claim refused');
}
it.each(changedClaims)('refuses a changed %s claim (%j)', refusesClaim);

async function refusesRead(change: string) {
  const original = context.nats.store.readStream.bind(context.nats.store);
  const subject = `delegation-${second.delegationId}`;
  async function* readStream(...args: Parameters<EventStore['readStream']>) {
    if (args[0] !== subject) {
      yield* original(...args);
      return;
    }
    expect(args[2]).toBeLessThanOrEqual(performance.now() + 2000);
    if (change === 'unavailable') throw new Error('private values');
    if (change === 'missing') return;
    if (change === 'late') await delay(2050);
    for await (const row of original(...args)) {
      const data = storedFields.parse(row.event.data);
      let changed: Record<string, unknown> = { ...data, requesterId: 'bob' };
      if (change === 'legacy') {
        changed = { delegationId: second.delegationId, parentComputerId: 'computer',
          childComputerId: 'other', rootBudgetId: 'root' };
      }
      if (change === 'late') changed = data;
      yield { ...row, event: { ...row.event, data: changed } };
    }
  }
  context.nats.store.readStream = readStream;
  try {
    expect(await request(context, claims(context, second))).toBe(refused);
  } finally {
    context.nats.store.readStream = original;
  }
  expect(await request(context, claims(context, second))).toBe(disabled);
}
it.each(['missing', 'legacy', 'mismatched', 'unavailable', 'late'])(
  'refuses a %s delegation read within the decision deadline', refusesRead);

async function refusesActivity(change: string) {
  const isolated = await setup();
  try {
    await admit(isolated, first);
    await admit(isolated, second);
    const position = await isolated.nats.store.head('budget-test');
    expect(await request(isolated, claims(isolated, second))).toBe(disabled);
    let subject = 'conversation-conversation';
    let type = change;
    let data: Record<string, unknown> = { conversationId: 'conversation',
      turnId: root.turnId };
    if (change === 'agent.turn_stop_requested') data['requestedBy'] = 'alice';
    if (change === 'conversation.closed') {
      data = { conversationId: 'conversation', closedBy: 'alice' };
    }
    if (change === 'parent closed' || change === 'child closed' || change === 'root closed') {
      subject = 'computer-assistant';
      type = 'computer.turn_closed';
      let binding: typeof root | ReturnType<typeof child> = first;
      if (change === 'child closed') binding = second;
      if (change === 'root closed') binding = root;
      data = { ...binding, status: 'completed' };
    }
    if (change === 'delegation.completed') {
      subject = `delegation-${second.delegationId}`;
      data = { version: 1, delegationId: second.delegationId, outcome: 'completed',
        terminalEvidence: { eventId: 'terminal', position: 1 } };
    }
    if (change === 'computer.ready') {
      subject = 'computer-assistant';
      data = { assistantId: 'assistant', computerId: 'computer', generation: 2, podUid: 'new' };
    }
    const event = { id: 'changed', commandId: 'changed', subject, type, data, silo: 'test',
      source: 'opencrane-server', principal: { kind: 'system' as const, id: 'opencrane-server' },
      time: new Date().toISOString(), correlation: {} };
    await isolated.nats.seed([event]);
    expect(await request(isolated, claims(isolated, second))).toBe(refused);
    await noSpending(isolated, position);
  } finally {
    await isolated.close();
  }
}
it.each(['agent.turn_stop_requested', 'agent.turn_completed', 'conversation.closed',
  'parent closed', 'child closed', 'root closed', 'computer.ready', 'delegation.completed'])(
  'refuses recorded root activity: %s', refusesActivity);

async function acceptsUnrelatedActivity() {
  await context.append('conversation-conversation', 'agent.turn_completed', {
    conversationId: 'conversation', turnId: 'unrelated' });
  expect(await request(context, claims(context, second))).toBe(disabled);
}
it('ignores completion of an unrelated turn', acceptsUnrelatedActivity);

async function directCheck(fields: Record<string, unknown>, patch = {},
  store = context.nats.store) {
  const turn = parseTurnToken({ iat: 1, exp: 121, ...fields });
  const computer = { assistant: 'assistant', computer: 'computer', generation: 1, ...patch };
  const checked = await context.credentials.check(context.headers);
  const started = performance.now();
  return checkNativeCall(store, context.binding, computer, turn, checked.sequence,
    started, started + 2000);
}
async function refusesComputer(field: string, value: unknown) {
  const patch = { [field]: value };
  await expect(directCheck(claims(context, first), patch)).rejects.toThrow(
    'Descendant claim refused');
  await expect(directCheck(claims(context, first))).rejects.toThrow(disabled);
}
it.each([['computer', 'other'], ['generation', 2]])(
  'compares the authenticated computer %s with the saved child', refusesComputer);

async function refusesEmptyModelScope() {
  const narrow = { ...child('narrow'), scopes: { ...scopes, models: [] } };
  await admit(context, narrow);
  expect(await request(context, claims(context, narrow))).toBe(refused);
  await expect(directCheck(claims(context, narrow))).rejects.toThrow(
    'Descendant model scope refused');
}
it('requires the selected model in the recorded model scope', refusesEmptyModelScope);

async function refusesRecordedParent(change: string) {
  const store = await createEventStore(await context.nats.client('command'));
  const original = store.readStream.bind(store);
  async function* readStream(...args: Parameters<EventStore['readStream']>) {
    for await (const row of original(...args)) {
      if (row.event.id !== first.delegationId) {
        yield row;
        continue;
      }
      if (change === 'missing') continue;
      const data = storedFields.parse(row.event.data);
      const changed = { ...data, threadId: 'wrong-parent-thread' };
      yield { ...row, event: { ...row.event, data: changed } };
    }
  }
  store.readStream = readStream;
  await expect(directCheck(claims(context, second), {}, store)).rejects.toThrow('Parent refused');
  await expect(directCheck(claims(context, second))).rejects.toThrow(disabled);
}
it.each(['missing', 'wrong'])('refuses a %s recorded parent', refusesRecordedParent);

async function refusesUnavailableComputerRead() {
  const store = await createEventStore(await context.nats.client('command'));
  function readStream(): ReturnType<EventStore['readStream']> {
    throw new Error('private binding values');
  }
  store.readStream = readStream;
  await expect(directCheck(claims(context, second), {}, store)).rejects.toThrow(
    /^Delegation agreement unavailable$/u);
}
it('refuses an unavailable computer read without exposing stored values',
  refusesUnavailableComputerRead);

async function refusesMissingComputerRecord() {
  const fields = { ...claims(context, first), delegation: ['alice', 'missing'] };
  expect(await request(context, fields)).toBe(refused);
  await expect(directCheck(fields)).rejects.toThrow('Descendant admission missing or closed');
}
it('requires a saved computer admission for the last delegation id', refusesMissingComputerRecord);
