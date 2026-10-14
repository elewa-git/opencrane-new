import { dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';
import { sharedContext } from '../src/chat/shared-context.ts';
import { chatHistory } from '../src/chat/commands.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
const admitted = { assistantId: 'assistant', computerId: 'computer', conversationId: 'child',
  turnId: 'input', requesterId: 'alice', threadId: 'shared-thread', task: 'chat_turn',
  executionMode: 'restricted', sharingClass: 'shared_only' };
const output = { assistantId: 'assistant', conversationId: 'child', turnId: 'input',
  requesterId: 'alice', threadId: 'shared-thread', executionMode: 'restricted',
  type: 'agent.message_completed', messageId: 'reply', text: 'Shared answer',
  sequence: 1, previousSequence: 0 };

async function close() {
  await nats?.close();
}
afterEach(close);

async function setup(start: Record<string, unknown> | undefined, source = 'opencrane-server') {
  nats = await natsFixture();
  const keys = conversationKeys(`${dirname(nats.env().NATS_CA_FILE)}/keys`);
  keys.provision('test', 'child');
  const creation = { conversationId: 'child', createdBy: 'alice', mode: 'agent_session',
    contextKind: 'shared_child', assistantId: 'assistant', payingGroupId: 'sales',
    initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }],
    origin: { parentConversationId: 'parent', sourceMessageId: 'source', sourcePosition: 2,
      intentEventId: 'intent', intentPosition: 3, requestId: 'request', firstInputId: 'input' } };
  const message = { conversationId: 'child', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...keys.encrypt('test', 'child', 'Shared question') };
  const rows = [
    { ...event('created', 'conversation-child', 'conversation.created'), data: creation },
    { ...event('input', 'conversation-child', 'message.posted'), data: message },
  ];
  await nats.seed(rows);
  if (start) {
    const saved = { ...event('start', 'computer-assistant', 'computer.turn_started'),
      source, data: start };
    await nats.seed([saved]);
  }
  return keys;
}

const refusals = [
  { name: 'no admitted start', start: undefined, patch: {} },
  { name: 'a private thread', start: admitted, patch: { threadId: 'private-thread' } },
  { name: 'no reported thread', start: admitted, patch: { threadId: undefined } },
  { name: 'a private turn', start: { ...admitted, turnId: 'private-input' }, patch: {} },
  { name: 'a private saved class', start: { ...admitted, sharingClass: undefined }, patch: {} },
  { name: 'another conversation', start: { ...admitted, conversationId: 'private' }, patch: {} },
  { name: 'another computer', start: { ...admitted, computerId: 'other' }, patch: {} },
  { name: 'another requester', start: { ...admitted, requesterId: 'bob' }, patch: {} },
  { name: 'a supplied output class', start: admitted, patch: { sharingClass: 'shared_only' } },
];
async function refusesOutput(test: typeof refusals[number]) {
  const keys = await setup(test.start);
  const report = { ...output, ...test.patch };
  await expect(recordReport(nats.store, keys, context, report)).rejects.toThrow();
  expect(await chatHistory(nats.store, 'test', 'child')).toHaveLength(2);
}
it.each(refusals)('refuses child output with $name before saving text', refusesOutput);

async function refusesUntrustedStart() {
  const keys = await setup(admitted, 'computer-bridge');
  await expect(recordReport(nats.store, keys, context, output)).rejects.toThrow();
  expect(await chatHistory(nats.store, 'test', 'child')).toHaveLength(2);
}
it('refuses output when the first saved start was not admitted by the server', refusesUntrustedStart);

async function acceptsOutputAndReplay() {
  const keys = await setup(admitted);
  expect(await recordReport(nats.store, keys, context, output)).toBe('recorded');
  const closed = { ...event('close', 'computer-assistant', 'computer.turn_closed'),
    data: { ...admitted, status: 'completed' } };
  await nats.seed([closed]);
  expect(await recordReport(nats.store, keys, context, output)).toBe('duplicate');
  const changed = { ...output, text: 'Substituted private text' };
  await expect(recordReport(nats.store, keys, context, changed)).rejects.toThrow();
  const next = { ...output, sequence: 2, previousSequence: 1 };
  await expect(recordReport(nats.store, keys, context, next)).rejects.toThrow();
  expect(await chatHistory(nats.store, 'test', 'child')).toHaveLength(3);
}
it('saves admitted shared output and only accepts its exact replay after closure',
  acceptsOutputAndReplay);

async function selectsCompletedSharedExchanges() {
  const keys = await setup(admitted);
  const rows = await chatHistory(nats.store, 'test', 'child');
  let sequence = rows.at(-1)!.sequence;
  function save(type: string, turnId: string, text?: string, authorId = 'bob') {
    const data = { conversationId: 'child', turnId, authorId, authorKind: 'human',
      contentType: 'text', ...keys.encrypt('test', 'child', text ?? 'excluded-canary') };
    sequence++;
    const id = type === 'message.posted' ? turnId : `history-${sequence}`;
    const saved = { ...event(id, 'conversation-child', type), data };
    const row = { sequence, event: saved };
    rows.push(row);
  }
  save('agent.message_completed', 'input', 'Shared answer');
  save('agent.turn_completed', 'input');
  for (const type of ['agent.message_delta', 'agent.reasoning_summarised', 'agent.command_ran',
    'agent.tool_call_finished', 'approval.decided', 'file.uploaded']) {
    save(type, 'input');
  }
  for (const type of ['unfinished', 'agent.turn_failed', 'agent.turn_stop_requested',
    'agent.output_lost']) {
    save('message.posted', type);
    save('agent.message_completed', type);
    if (type !== 'unfinished') {
      save(type, type);
      save('agent.turn_completed', type);
    }
  }
  save('message.posted', 'next', 'New input');
  save('agent.turn_started', 'next');
  function decrypt(data: unknown) {
    const text = keys.decrypt('test', 'child', data);
    expect(text).not.toContain('excluded-canary');
    return text;
  }
  function isCurrent(row: typeof rows[number]) {
    return row.event.id === 'next';
  }
  const message = rows.find(isCurrent)!;
  const expected = sharedContext(rows, message, decrypt);
  expect(expected?.exchanges[0]).toMatchObject({ member: 'Shared question',
    assistant: ['Shared answer'] });
  expect(expected?.exchanges).toHaveLength(5);
  for (const exchange of expected!.exchanges.slice(1)) {
    expect(Object.keys(exchange)).toEqual(['at', 'outcome']);
    expect(exchange).toMatchObject({ outcome: 'not_completed' });
  }
  save('agent.message_completed', 'input', 'excluded-canary-late');
  const rebuilt = structuredClone(rows);
  expect(sharedContext(rebuilt, message, decrypt)).toEqual(expected);
  expect(sharedContext(rows, rows[1]!, decrypt)).toBeUndefined();
}
it('rebuilds completed shared exchanges and time-only unfinished records at the saved start',
  selectsCompletedSharedExchanges);

async function boundsSharedExchanges() {
  const keys = await setup(admitted);
  const rows = await chatHistory(nats.store, 'test', 'child');
  const first = rows[1]!;
  for (let index = 0; index < 4; index++) {
    const id = `large-${index}`;
    const content = keys.encrypt('test', 'child', `${index}${'界'.repeat(3000)}`);
    const message = { ...first, sequence: index * 3 + 10,
      event: { ...first.event, id, data: { conversationId: 'child', authorId: 'bob',
        authorKind: 'human', contentType: 'text', ...content } } };
    rows.push(message, { sequence: index * 3 + 11,
      event: { ...event(`done-${index}`, 'conversation-child', 'agent.turn_completed'),
        data: { turnId: id } } });
  }
  const current = { ...first, sequence: 30, event: { ...first.event, id: 'current' } };
  function decrypt(data: unknown) { return keys.decrypt('test', 'child', data); }
  const result = sharedContext(rows, current, decrypt);
  expect(result?.omittedExchanges).toBe(3);
  expect(result?.exchanges).toHaveLength(2);
  expect(result?.exchanges[0]).toMatchObject({ member: `2${'界'.repeat(3000)}` });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24 * 1024);
}
it('keeps newest whole shared exchanges within 24 KiB and counts omissions', boundsSharedExchanges);
