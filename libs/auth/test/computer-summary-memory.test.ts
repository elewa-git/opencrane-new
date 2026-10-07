import { expect, it } from 'vitest';
import { readStreamSummary } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import { computerSummary, type ComputerSummary } from '../src/index.ts';

const binding = { assistantId: 'assistant', computerId: 'computer', conversationId: 'chat',
  requesterId: 'alice', threadId: 'thread', task: 'chat_turn' };
function rowEvent(id: string, type: string, data: Record<string, unknown>) {
  return { ...event(id, 'computer-assistant', type), data };
}

async function rebuildsOversizedComputerFacts(open: boolean) {
  const fromPositions: number[] = [];
  async function* readStream(_subject: string, from = 1) {
    fromPositions.push(from);
    await Promise.resolve();
    if (open) {
      for (let index = 0; index < 200000; index++) {
        const openBinding = { ...binding, turnId: 'open' };
        const event = rowEvent(`start-${index}`, 'computer.turn_started', openBinding);
        if (index + 1 >= from) yield { sequence: index + 1, event };
      }
      return;
    }
    for (let index = 0; index < 60000; index++) {
      const data = { ...binding, turnId: `closed-${index}`, threadId: `thread-${index}` };
      const start = rowEvent(`start-${index}`, 'computer.turn_started', data);
      const closedData = { ...data, status: 'completed' };
      const closed = rowEvent(`close-${index}`, 'computer.turn_closed', closedData);
      const sequence = index * 2 + 1;
      if (sequence >= from) yield { sequence, event: start };
      if (sequence + 1 >= from) yield { sequence: sequence + 1, event: closed };
    }
  }
  const store = { readStream };
  function refusalFacts(summary: ComputerSummary) {
    return { closed: summary.turns.get('closed-0')?.firstClose?.status,
      openCommandCount: summary.turns.get('open')?.startCommandKeys?.size,
      owners: summary.threads.get('thread-0')?.owners.size };
  }
  const first = await readStreamSummary(
    store, 'test', 'computer-assistant', computerSummary, Infinity, refusalFacts);
  const second = await readStreamSummary(
    store, 'test', 'computer-assistant', computerSummary, Infinity, refusalFacts);
  expect(second).toEqual(first);
  if (open) {
    expect(second.openCommandCount).toBe(200000);
  } else {
    expect(second.closed).toBe('completed');
    expect(second.owners).toBe(1);
  }
  expect(fromPositions).toEqual([1, 1]);
}
it.each([false, true])('bounds retained computer turns, threads and start keys (open=%s)',
  rebuildsOversizedComputerFacts);

async function keepsBusyTeamAssistantsWarm() {
  const fromPositions: { subject: string; from: number }[] = [];
  async function* readStream(subject: string, from = 1) {
    fromPositions.push({ subject, from });
    await Promise.resolve();
    for (let index = Math.floor((from - 1) / 2); index < 10000; index++) {
      const data = { ...binding, turnId: `closed-${index}`, threadId: `thread-${index}`,
        executionMode: 'restricted' };
      const start = rowEvent(`start-${index}`, 'computer.turn_started', data);
      const closedData = { ...data, status: 'completed' };
      const closed = rowEvent(`close-${index}`, 'computer.turn_closed', closedData);
      const sequence = index * 2 + 1;
      if (sequence >= from) yield { sequence, event: start };
      if (sequence + 1 >= from) yield { sequence: sequence + 1, event: closed };
    }
  }
  const store = { readStream };
  function take(summary: ComputerSummary) {
    return { closed: summary.turns.get('closed-0')?.firstClose?.status,
      restrictedTurns: summary.threads.get('thread-0')?.restrictedTurnIds.size,
      turns: summary.turns.size, threads: summary.threads.size };
  }
  const expected = { closed: 'completed', restrictedTurns: 1, turns: 10000, threads: 10000 };
  const subjects = ['computer-first', 'computer-second', 'computer-third'];
  for (const subject of subjects) {
    expect(await readStreamSummary(store, 'test', subject, computerSummary, Infinity, take))
      .toEqual(expected);
  }
  fromPositions.length = 0;
  for (const subject of subjects) {
    expect(await readStreamSummary(store, 'test', subject, computerSummary, Infinity, take))
      .toEqual(expected);
  }
  expect(fromPositions).toEqual([
    { subject: 'computer-first', from: 20001 },
    { subject: 'computer-second', from: 20001 },
    { subject: 'computer-third', from: 20001 },
  ]);
}
it('keeps three team assistants with 10,000 restricted turns each warm',
  keepsBusyTeamAssistantsWarm);
