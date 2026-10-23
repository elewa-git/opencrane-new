import * as timers from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { readComputerControl } from '@opencrane/auth';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { watchTakeoverDeadline } from '../src/chat/bridge-deadline.ts';
import { pauseTimeRemaining } from '../src/chat/bridge-pause-time.ts';
import { saveFailed, savePausing, savePaused } from '../src/chat/bridge-pausing.ts';
import { takeoverClock } from './support/takeover-clock.ts';

vi.mock('node:timers/promises', { spy: true });

let close = async () => {};
afterEach(async function cleanup() {
  vi.restoreAllMocks();
  await close();
});

async function setup() {
  const test = await natsFixture();
  const abort = new AbortController();
  const tasks: Promise<void>[] = [];
  const logger = createLogger('deadline-test');
  async function cleanup() {
    abort.abort();
    await Promise.all(tasks);
    await test.close();
  }
  close = cleanup;
  const binding = { computerId: 'computer', assistantId: 'assistant', generation: 1,
    podUid: 'pod', takeoverId: 'takeover', affectedTurnIds: ['turn'] };
  const intent = { ...binding, conversationId: 'chat', requesterId: 'alice',
    requesterEventId: 'turn', leaseId: 'takeover', reason: 'requester_requested' };
  const event = envelope('test', 'computer-assistant', 'takeover.requested', intent);
  await test.seed([event]);
  const control = await readComputerControl(test.store, 'test', 'assistant');
  if (!control || control.phase !== 'requested') throw new Error('Missing request');
  function watch() {
    const task = watchTakeoverDeadline(test.store, 'test', 'assistant', abort.signal, logger);
    tasks.push(task);
    return task;
  }
  return { ...test, abort, control, watch, binding };
}

async function capsFutureRequest() {
  const test = await setup();
  const clock = takeoverClock(test.control.requestedAt);
  const future = new Date(Date.parse(test.control.requestedAt) + 60_000).toISOString();
  const control = { ...test.control, requestedAt: future };
  expect(pauseTimeRemaining(test.store, 'test', control)).toBe(30_000);
  clock.advance(29_999, -60_000);
  expect(pauseTimeRemaining(test.store, 'test', control)).toBe(1);
  clock.advance(30_000, -60_000);
  expect(pauseTimeRemaining(test.store, 'test', control)).toBe(0);
}
it('caps a future saved time at the first observation despite clock rollback', capsFutureRequest);

async function invalidTimeExpires() {
  const test = await setup();
  const control = { ...test.control, requestedAt: 'not a date' };
  expect(pauseTimeRemaining(test.store, 'test', control)).toBe(0);
}
it('treats an invalid saved time as expired', invalidTimeExpires);

async function releasesObservation() {
  const test = await setup();
  const original = Map.prototype.set;
  let retained: Map<unknown, unknown> | undefined;
  function capture(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof key === 'string' && key.startsWith('["test","assistant"')) retained = this;
    return original.call(this, key, value);
  }
  vi.spyOn(Map.prototype, 'set').mockImplementation(capture);
  pauseTimeRemaining(test.store, 'test', test.control);
  expect(retained?.size).toBe(1);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(test.control.requestedAt) + 30_000);
  await test.watch();
  expect((await readComputerControl(test.store, 'test', 'assistant'))?.phase).toBe('failed');
  expect(retained?.size).toBe(0);
}
it('releases the saved observation after the failure is stored', releasesObservation);

async function reusesCheckedPosition() {
  const test = await setup();
  const read = vi.spyOn(test.store, 'readStream');
  const head = test.store.head.bind(test.store);
  const polled = Promise.withResolvers<void>();
  let calls = 0;
  async function count(...args: Parameters<typeof head>) {
    const position = await head(...args);
    calls++;
    if (calls === 3) polled.resolve();
    return position;
  }
  vi.spyOn(test.store, 'head').mockImplementation(count);
  const watching = test.watch();
  await polled.promise;
  test.abort.abort();
  await watching;
  expect(read).toHaveBeenCalledTimes(1);
}
it('reuses control history while the checked stream position is unchanged', reusesCheckedPosition);

async function checksPositionBeforeHistory() {
  const test = await setup();
  const read = test.store.readStream.bind(test.store);
  let changed = false;
  async function* changeBeforeRead(...args: Parameters<typeof read>) {
    if (!changed) {
      changed = true;
      const event = envelope('test', 'computer-assistant', 'computer.lost', {
        computerId: 'computer', assistantId: 'assistant',
      });
      await test.seed([event]);
    }
    yield* read(...args);
  }
  vi.spyOn(test.store, 'readStream').mockImplementation(changeBeforeRead);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(test.control.requestedAt) + 30_000);
  const append = vi.spyOn(test.store, 'append');
  await test.watch();
  const expectations = [];
  for (const [command] of append.mock.calls) expectations.push(command.expectedSequence);
  expect(expectations).toEqual([test.control.position, test.control.position + 1]);
  expect((await readComputerControl(test.store, 'test', 'assistant'))?.phase).toBe('failed');
}
it('rejects an unchecked position when history changes during the read', checksPositionBeforeHistory);

async function abortAfterRead() {
  const test = await setup();
  const read = test.store.readStream.bind(test.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function* hold(...args: Parameters<typeof read>) {
    yield* read(...args);
    entered.resolve();
    await release.promise;
  }
  vi.spyOn(test.store, 'readStream').mockImplementation(hold);
  const append = vi.spyOn(test.store, 'append');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(test.control.requestedAt) + 30_000);
  const watching = test.watch();
  try {
    await entered.promise;
    test.abort.abort();
  } finally {
    release.resolve();
    await watching;
  }
  expect(append).not.toHaveBeenCalled();
}
it('saves nothing when shutdown arrives during the control read', abortAfterRead);

async function shortensLastSleep() {
  const test = await setup();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(test.control.requestedAt) + 29_950);
  const sleep = vi.mocked(timers.setTimeout);
  sleep.mockClear();
  await test.watch();
  function isDeadlineSleep(call: Parameters<typeof timers.setTimeout>) {
    return call[2]?.signal === test.abort.signal;
  }
  const sleeps = sleep.mock.calls.filter(isDeadlineSleep);
  expect(sleeps.length).toBeGreaterThan(0);
  expect(sleeps[0]?.[0]).toBeLessThanOrEqual(50);
  expect((await readComputerControl(test.store, 'test', 'assistant'))?.phase).toBe('failed');
}
it('shortens the polling sleep to the time left before expiry', shortensLastSleep);

async function terminalDoesNotAppend(phase: 'paused' | 'failed' | 'unverified') {
  const test = await setup();
  const control = test.control;
  if (phase === 'paused') {
    const receipt = { kind: 'executor_stop', generation: 1, podUid: 'pod',
      takeoverId: 'takeover', affectedTurnIds: ['turn'], epoch: 'supervisor',
      executionQuiet: true, executionInventory: [], desktopInventory: [],
      quietProof: 'complete', controlEnabled: false };
    await savePausing(test.store, 'test', control, control.position, 'bridge', receipt);
    const pausing = await readComputerControl(test.store, 'test', 'assistant');
    if (!pausing || pausing.phase !== 'pausing') throw new Error('Missing pausing');
    await savePaused(test.store, 'test', pausing, pausing.position, 'bridge', receipt);
  } else if (phase === 'failed') {
    await saveFailed(test.store, 'test', control, control.position);
  } else {
    const data = { ...test.binding, takeoverId: 'other', reason: 'pause_timeout' };
    await test.seed([envelope('test', 'computer-assistant', 'takeover.failed', data)]);
  }
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(control.requestedAt) + 30_000);
  const append = vi.spyOn(test.store, 'append');
  let finished = false;
  function done() { finished = true; }
  const watching = test.watch().then(done);
  await timers.setTimeout(300);
  const finishedBeforeShutdown = finished;
  test.abort.abort();
  await watching;
  expect(append).not.toHaveBeenCalled();
  expect(finishedBeforeShutdown).toBe(true);
}
it.each(['paused', 'failed', 'unverified'] as const)(
  'retires without appending for %s control', terminalDoesNotAppend);
