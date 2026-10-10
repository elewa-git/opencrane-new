import { afterEach, expect, it } from 'vitest';
import { getEventDefinition } from '@opencrane/events';
import { readStreamSummary, type StoredEvent } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { computerSummary, type ComputerSummary } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
async function close() {
  await nats?.close();
}
afterEach(close);
const identity = { assistantId: 'assistant', computerId: 'computer', generation: 1 };
const binding = { assistantId: 'assistant', computerId: 'computer', conversationId: 'chat',
  requesterId: 'alice', threadId: 'thread', task: 'chat_turn' };
function rowEvent(id: string, type: string, data: Record<string, unknown>) {
  return { ...event(id, 'computer-assistant', type), data };
}
function take(summary: ComputerSummary) {
  return structuredClone(summary);
}
async function facts() {
  return readStreamSummary(nats.store, 'test', 'computer-assistant',
    computerSummary, Infinity, take);
}
async function boundsThreadFactsAndShrinksClosedTurns() {
  nats = await natsFixture();
  const events = [];
  for (let index = 0; index < 500; index++) {
    const data = { ...binding, turnId: `turn-${index}`, requesterId: `member-${index}`,
      executionMode: 'restricted' };
    events.push(rowEvent(`start-${index}`, 'computer.turn_started', data));
    events.push(rowEvent(`close-${index}`, 'computer.turn_closed', { ...data, status: 'completed' }));
  }
  await nats.seed(events);
  const summary = await facts();
  const thread = summary.threads.get('thread');
  expect(thread?.owners.size).toBe(2);
  expect(thread?.startedTurnIds.size).toBe(2);
  expect(thread?.restrictedTurnIds.size).toBe(2);
  expect(summary.turns.get('turn-0')).toEqual({ hasStart: true,
    firstClose: { sequence: 2, status: 'completed' } });
  expect(summary.turns.get('turn-499')).toEqual({ hasStart: true,
    firstClose: { sequence: 1000, status: 'completed' } });
}
it('bounds all thread sets to two values and drops open-turn details after close',
  boundsThreadFactsAndShrinksClosedTurns);

async function matchesRebuildAtFiveCuts() {
  nats = await natsFixture();
  const events = [rowEvent('claim', 'computer.claimed', { ...identity, tokenId: 'token:first' }),
    rowEvent('ready', 'computer.ready', identity)];
  for (let index = 0; index < 20; index++) {
    const data = { ...binding, turnId: `turn-${index}` };
    events.push(rowEvent(`start-${index}`, 'computer.turn_started', data));
    events.push(rowEvent(`close-${index}`, 'computer.turn_closed', { ...data, status: 'failed' }));
  }
  events.push(rowEvent('resume', 'computer.resumed', { ...identity, tokenId: 'token:rotated' }));
  events.push(rowEvent('ready-again', 'computer.ready', identity));
  const open = { ...binding, turnId: 'open' };
  events.push(rowEvent('open-first', 'computer.turn_started', { ...open, executionMode: 'restricted' }));
  events.push(rowEvent('open-latest', 'computer.turn_started', open));
  let added = 0;
  for (const cut of [3, 11, 24, 43, 46]) {
    await nats.seed(events.slice(added, cut));
    added = cut;
    const incremental = await facts();
    const rebuilt = computerSummary.empty();
    for await (const row of nats.reader.readStream('computer-assistant')) {
      computerSummary.add(rebuilt, row);
    }
    expect(incremental).toEqual(rebuilt);
  }
  const summary = await facts();
  expect(summary.lifecycle?.event.id).toBe('ready-again');
  expect(summary.claim?.event.id).toBe('claim');
  expect(summary.grant?.event.id).toBe('resume');
  expect(summary.turns.get('open')?.firstStart?.event.id).toBe('open-first');
  expect(summary.turns.get('open')?.lastStartExecutionMode).toBeUndefined();
  expect(summary.turns.get('open')?.startCommandKeys?.size).toBe(2);
}
it('matches a full rebuild at five cuts and keeps first starts and newest lifecycle facts',
  matchesRebuildAtFiveCuts);

async function checksBeforeChangingFacts() {
  nats = await natsFixture();
  const summary = computerSummary.empty();
  const invalid: StoredEvent = { sequence: 1,
    event: rowEvent('invalid', 'computer.turn_started', { turnId: 'turn' }) };
  expect(() => computerSummary.add(summary, invalid)).toThrow();
  expect(summary.turns.size).toBe(0);
  expect(summary.threads.size).toBe(0);
  expect(summary.lifecycle).toBeUndefined();
}
it('leaves the summary unchanged when start fields are invalid', checksBeforeChangingFacts);

function ignoresNativeAuthority() {
  const example: unknown = getEventDefinition('delegation.started')?.example;
  if (typeof example !== 'object' || example === null) throw new Error('Missing native example');
  const native: Record<string, unknown> = { ...example, task: 'native_descendant' };
  delete native['version'];
  delete native['computerAdmission'];
  const summary = computerSummary.empty();
  const start = rowEvent('native-start', 'computer.turn_started', native);
  computerSummary.add(summary, { sequence: 1, event: start });
  const closed = { ...native, status: 'cancelled' };
  const close = rowEvent('native-close', 'computer.turn_closed', closed);
  computerSummary.add(summary, { sequence: 2, event: close });
  expect(summary).toEqual(computerSummary.empty());
}
it('keeps native records out of turn and thread authority', ignoresNativeAuthority);
