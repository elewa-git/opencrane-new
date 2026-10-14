import { once } from 'node:events';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { fixture } from './bridge-gate-fixture.ts';

const unsignedGate = {
  type: 'bridge_gate',
  takeoverId: 'takeover',
  generation: 1,
  affectedTurnIds: ['first', 'second'],
};
const staleGeneration = { ...unsignedGate, generation: 999 };
const oldGate = { ...unsignedGate, takeoverId: 'foreign-or-stale' };
const foreignGate = { ...unsignedGate, takeoverId: 'another-computer-takeover' };
const claimedProof = {
  ...unsignedGate,
  computerId: 'another-computer',
  signature: 'untrusted-signature',
};
const requests = [
  { name: 'stale generation', request: staleGeneration },
  { name: 'replayed old gate', request: oldGate },
  { name: 'foreign computer gate', request: foreignGate },
  { name: 'unsigned gate', request: unsignedGate },
  { name: 'caller-supplied proof', request: claimedProof },
];

async function refusesFirstGate(input: typeof requests[number]) {
  const test = await fixture();
  try {
    test.start('first');
    test.start('second', 'restricted');
    function bothRunning() {
      return test.calls.includes('turn/start:thread-2');
    }
    await until(bothRunning);
    const callsBefore = [...test.calls];
    const grantsBefore = [...test.grants];
    const cataloguesBefore = [...test.catalogues];
    const loadedBefore = [...test.loaded];

    // Send the gate before resume so no earlier request can supply its authority.
    const socket = await test.connect(false);
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(input.request));
    function socketClosed() {
      return socket.readyState === socket.CLOSED;
    }
    await until(socketClosed, 1000);
    const closeValues: unknown[] = await closed;
    const [code, reason] = closeValues;
    expect(code).toBe(1008);
    expect(String(reason)).toBe('Invalid bridge message');
    expect(test.calls).toEqual(callsBefore);
    expect([...test.grants]).toEqual(grantsBefore);
    expect([...test.catalogues]).toEqual(cataloguesBefore);
    expect([...test.loaded]).toEqual(loadedBefore);
    function isGateReceipt(frame: Record<string, unknown>) {
      return frame['type'] === 'bridge_quiet' || frame['type'] === 'bridge_unavailable';
    }
    expect(test.frames.some(isGateReceipt)).toBe(false);

    const resumed = await test.connect();
    test.finish('thread-1');
    test.finish('thread-2');
    function isCompleted(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.turn_completed';
    }
    function bothCompleted() {
      const completed = test.frames.filter(isCompleted);
      return completed.length === 2;
    }
    await until(bothCompleted);
    const nextTurn = {
      type: 'turn', id: 'third', conversationId: 'third', assistantId: 'assistant',
      text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000,
    };
    resumed.send(JSON.stringify(nextTurn));
    function nextRunning() {
      return test.calls.includes('turn/start:thread-3');
    }
    await until(nextRunning);
    expect(test.frames.some(isGateReceipt)).toBe(false);
    test.finish('thread-3');
  } finally {
    await test.close();
  }
}

it.each(requests)('refuses $name as the first request without stopping turns', refusesFirstGate);
