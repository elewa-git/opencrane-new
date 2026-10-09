import { afterEach, expect, it, vi } from 'vitest';
import { readEventAt, type AppendCommand } from '@opencrane/event-store';
import { event as fixtureEvent, countReads, expectNoWholeReads, natsFixture } from '@opencrane/event-store/testing';
import { turnCommand } from '../src/chat/turns.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
const input = { conversationId: 'chat', turnId: 'message', threadId: 'thread',
  status: 'started' as const };
const subject = 'computer-assistant';
const identity = { assistantId: 'assistant', computerId: 'computer' };
const turnData = { ...identity, conversationId: 'chat', turnId: 'message', threadId: 'thread',
  requesterId: 'alice', task: 'chat_turn' };
async function close() {
  vi.restoreAllMocks();
  await nats?.close();
}
afterEach(close);
function event(id: string, subject: string, type: string) {
  const base = fixtureEvent(id, subject, type);
  const data: Record<string, unknown> = { ...base.data };
  delete data['memberId'];
  return { ...base, data };
}
function computerEvent(id: string, type: string, data: Record<string, unknown>) {
  return { ...event(id, subject, type), data };
}
async function setup(kind: 'personal' | 'team' = 'personal') {
  nats = await natsFixture();
  await nats.seed([
    { ...event('created', 'conversation-chat', 'conversation.created'), data: {
      conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
    } },
    { ...event('message', 'conversation-chat', 'message.posted'), data: {
      ...event('message', 'conversation-chat', 'message.posted').data,
      conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text',
    } },
    { ...event('assistant', 'assistant-assistant', 'assistant.created'), data: {
      assistantId: 'assistant', ownerId: 'alice', kind,
    } },
    computerEvent('ready', 'computer.ready', { ...identity, generation: 1 }),
    { ...event('budget', 'budget-test', 'budget.ceiling_set'), data: {
      scope: 'global', ceilingCents: 20000, setBy: 'alice', defaultPayingGroupId: 'personal',
    } },
  ]);
}
async function warmTurnDoesNotRereadComputer() {
  await setup();
  const rows = [];
  for (let index = 0; index < 500; index++) {
    const data = { ...turnData, turnId: `old-${index}`, threadId: `old-thread-${index}` };
    rows.push(computerEvent(`start-${index}`, 'computer.turn_started', data));
    rows.push(computerEvent(`close-${index}`, 'computer.turn_closed', {
      ...data, status: 'completed',
    }));
  }
  await nats.seed(rows);
  const first = await turnCommand(nats.store, context, input);
  const reads = countReads(nats.store);
  const append = vi.spyOn(nats.store, 'append');
  expect(await turnCommand(nats.store, context, { ...input, replay: true })).toEqual(first);
  expect(append).not.toHaveBeenCalled();
  await turnCommand(nats.store, context, { ...input, status: 'completed' });
  await nats.seed([{ ...event('next', 'conversation-chat', 'message.posted'),
    data: { ...event('next', 'conversation-chat', 'message.posted').data,
      conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text' } }]);
  expect(await turnCommand(nats.store, context, { ...input, turnId: 'next' })).toMatchObject({
    turnId: 'next', payingGroupId: 'personal',
  });
  expectNoWholeReads(reads.calls);
  let computerRows = 0;
  for (const call of reads.calls) {
    if (call.subject === subject) computerRows += call.rows;
  }
  expect(computerRows).toBeLessThanOrEqual(5);
}
it('starts, closes and replays warm turns without rereading 500 earlier turns',
  warmTurnDoesNotRereadComputer);

async function refusesWrongReadBack(position: 'missing' | 'different') {
  await setup();
  const append = nats.store.append.bind(nats.store);
  async function wrongPosition(command: AppendCommand) {
    const result = await append(command);
    if (result.status !== 'appended') return result;
    if (position === 'missing') return { ...result, sequence: result.sequence + 1 };
    const saved = await readEventAt(nats.store, subject, result.sequence, Infinity);
    if (!saved) throw new Error('Missing fixture start');
    await nats.seed([{ ...saved.event, id: 'other-start', commandId: 'other-start' }]);
    return { ...result, sequence: await nats.store.head(subject) };
  }
  vi.spyOn(nats.store, 'append').mockImplementation(wrongPosition);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow('Turn binding conflict');
}
it.each(['missing', 'different'] as const)(
  'refuses a %s event at the turn append position with the existing error', refusesWrongReadBack);

type Refusal = { name: string; type: string; data: Record<string, unknown>; error: string;
  kind?: 'personal' | 'team'; mode?: 'restricted' | 'memory_free' };
const refusalCases: Refusal[] = [
  { name: 'a refused admission', type: 'computer.turn_closed',
    data: { ...turnData, status: 'failed' }, error: 'Turn admission was refused' },
  { name: 'a closed turn', type: 'computer.turn_closed',
    data: { ...turnData, status: 'completed' }, error: 'Turn is closed' },
  { name: 'a thread used by another requester', type: 'computer.turn_started',
    data: { ...turnData, turnId: 'old', requesterId: 'bob' },
    error: 'Thread belongs to another requester or conversation' },
  { name: 'a thread used by another conversation', type: 'computer.turn_started',
    data: { ...turnData, turnId: 'old', conversationId: 'other-chat' },
    error: 'Thread belongs to another requester or conversation' },
  { name: 'a restricted turn on a used memory-free thread', type: 'computer.turn_started',
    data: { ...turnData, turnId: 'old', executionMode: 'memory_free' },
    kind: 'team', mode: 'restricted', error: 'Private thread reused' },
  { name: 'a memory-free turn on a used restricted thread', type: 'computer.turn_started',
    data: { ...turnData, turnId: 'old', executionMode: 'restricted' },
    error: 'Private thread reused' },
  { name: 'a suspended computer', type: 'computer.suspended', data: identity,
    error: 'Computer is not ready' },
  { name: 'a different ready computer', type: 'computer.ready',
    data: { ...identity, computerId: 'other', generation: 1 }, error: 'Computer is not ready' },
  { name: 'a changed thread for an open turn', type: 'computer.turn_started',
    data: { ...turnData, threadId: 'original' }, error: 'Thread mismatch' },
];
async function keepsRefusal(test: Refusal) {
  await setup(test.kind);
  await nats.seed([computerEvent('previous', test.type, test.data)]);
  const start = { ...input, executionMode: test.mode ?? 'memory_free' };
  await expect(turnCommand(nats.store, context, start)).rejects.toThrow(test.error);
  const append = vi.spyOn(nats.store, 'append');
  const replay = { ...start, replay: true };
  if (test.error === 'Turn is closed') {
    expect(await turnCommand(nats.store, context, replay)).toBeUndefined();
  } else if (test.error === 'Private thread reused') {
    await expect(turnCommand(nats.store, context, replay)).rejects.toThrow('Turn admission was refused');
  } else {
    await expect(turnCommand(nats.store, context, replay)).rejects.toThrow(test.error);
  }
  expect(append).not.toHaveBeenCalled();
}
it.each(refusalCases)('keeps the refusal for $name', keepsRefusal);

async function keepsFirstCloseAndLateStart() {
  await setup();
  await nats.seed([computerEvent('first-close', 'computer.turn_closed', {
    ...turnData, status: 'completed',
  })]);
  await nats.seed([computerEvent('later-close', 'computer.turn_closed', {
    ...turnData, status: 'failed',
  })]);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow('Turn is closed');
  await nats.seed([computerEvent('late-start', 'computer.turn_started', turnData)]);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow('Turn is closed');
  expect(await turnCommand(nats.store, context, { ...input, replay: true })).toBeUndefined();
}
it('uses the first close and remembers a start arriving after it', keepsFirstCloseAndLateStart);

async function keepsFirstBindingAndLatestMode() {
  await setup();
  const first = { ...turnData, payingGroupId: 'original-payer', executionMode: 'memory_free' };
  await nats.seed([computerEvent('first-start', 'computer.turn_started', first)]);
  await nats.seed([computerEvent('second-start', 'computer.turn_started', {
    ...first, payingGroupId: 'later-payer', executionMode: 'restricted',
  })]);
  const admitted = await turnCommand(nats.store, context, input);
  expect(admitted).toMatchObject({ payingGroupId: 'original-payer', executionMode: 'restricted' });
  const append = vi.spyOn(nats.store, 'append');
  expect(await turnCommand(nats.store, context, input)).toEqual(admitted);
  expect(append).not.toHaveBeenCalled();
}
it('keeps the first start binding and the newest start execution mode', keepsFirstBindingAndLatestMode);

async function refusesWrongSilo() {
  await setup();
  const wrong = { ...computerEvent('wrong-silo', 'computer.ready', {
    ...identity, generation: 1,
  }), silo: 'other' };
  await nats.seed([wrong]);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow('Computer silo mismatch');
}
it('keeps the computer silo mismatch refusal', refusesWrongSilo);

async function refusesFinalReportBeforeAdmission() {
  await setup();
  await nats.seed([{ ...event('completed', 'conversation-chat', 'agent.turn_completed'),
    data: { conversationId: 'chat', turnId: 'message' } }]);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow('Turn is closed');
  expect(await turnCommand(nats.store, context, { ...input, replay: true })).toBeUndefined();
}
it('refuses a new start after the final report and accepts its recovery replay',
  refusesFinalReportBeforeAdmission);

async function keepsPositionFromBeforeAdmission() {
  await setup();
  const readStream = nats.store.readStream.bind(nats.store);
  let suspended = false;
  async function* suspendDuringAdmission(subject: string, from?: number, deadline?: number) {
    if (subject === 'assistant-assistant' && !suspended) {
      suspended = true;
      await nats.seed([computerEvent('suspend-during-admission', 'computer.suspended', identity)]);
    }
    yield* readStream(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(suspendDuringAdmission);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow(
    'Turn append conflict or unavailable');
  const starts = [];
  for await (const row of readStream('computer-assistant')) {
    if (row.event.type === 'computer.turn_started') starts.push(row);
  }
  expect(starts).toHaveLength(0);
}
it('keeps the position read with the facts when suspension lands during admission',
  keepsPositionFromBeforeAdmission);

async function failedCloseWithLateStartRemainsClosed() {
  await setup();
  await nats.seed([computerEvent('failed-close', 'computer.turn_closed', {
    ...turnData, status: 'failed',
  })]);
  await nats.seed([computerEvent('late-start', 'computer.turn_started', turnData)]);
  await expect(turnCommand(nats.store, context, input)).rejects.toThrow('Turn is closed');
  expect(await turnCommand(nats.store, context, { ...input, replay: true })).toBeUndefined();
}
it('keeps a failed closed turn closed when a start arrives later', failedCloseWithLateStartRemainsClosed);

async function keepsConcurrentTurnCondition() {
  await setup();
  const next = event('next-message', 'conversation-chat', 'message.posted');
  await nats.seed([{ ...next, data: { ...next.data, conversationId: 'chat', authorId: 'alice' } }]);
  const append = nats.store.append.bind(nats.store);
  let arrivals = 0;
  const ready = Promise.withResolvers<void>();
  async function appendTogether(command: AppendCommand) {
    arrivals++;
    if (arrivals === 2) ready.resolve();
    await ready.promise;
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(appendTogether);
  const secondInput = { ...input, turnId: 'next-message', threadId: 'next-thread' };
  const outcomes = await Promise.allSettled([
    turnCommand(nats.store, context, input), turnCommand(nats.store, context, secondInput),
  ]);
  const successful = [];
  const refused: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') successful.push(outcome.value);
    else refused.push(outcome.reason);
  }
  expect(successful).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toBeInstanceOf(Error);
  expect(refused[0]).toHaveProperty('message', 'Turn append conflict or unavailable');
}
it('keeps one conditional append when two new turns race on an assistant', keepsConcurrentTurnCondition);

async function keepsRecordedProviderChoice() {
  await setup();
  const choice = { providerId: 'primary', bindingSequence: 12, model: 'gpt-6-luna' };
  const started = { ...turnData, payingGroupId: 'personal', ...choice };
  await nats.seed([computerEvent('bound-start', 'computer.turn_started', started)]);
  const admitted = await turnCommand(nats.store, context, input);
  expect(admitted).toMatchObject(choice);
  const moved = { providerId: 'secondary', revision: 3, changedBy: 'alice',
    kind: 'assistant', dependantId: 'assistant', task: 'chat_turn',
    previousBindingSequence: 12, expectedProviderSequence: 12,
    state: 'paused', model: 'gpt-6.1-sol', reason: 'Paused by an administrator' };
  await nats.seed([{ ...event('moved', 'provider-secondary', 'provider.model_binding_set'),
    data: moved }]);
  expect(await turnCommand(nats.store, context, { ...input, replay: true })).toEqual(admitted);
  await turnCommand(nats.store, context, { ...input, status: 'completed' });
  let lastData: unknown;
  for await (const row of nats.store.readStream(subject)) {
    lastData = row.event.data;
  }
  expect(lastData).toMatchObject({ ...choice, status: 'completed' });
}
it('keeps the recorded provider and model on replay and closure after a binding moves',
  keepsRecordedProviderChoice);
