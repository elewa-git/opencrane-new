import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { envelope } from '@opencrane/models';
import * as observability from '@opencrane/observability';
import { SandboxClient } from '../src/kubernetes.ts';
import { watchComputers } from '../src/lifecycle.ts';
import { computerFixture } from './computer-fixture.ts';

const turn = { conversationId: 'chat', turnId: 'turn', threadId: 'thread',
  requesterId: 'alice', task: 'chat_turn' };

async function checksOnlyCurrentGeneration(latest: string, staleTurn: boolean) {
  const fixture = await computerFixture({ suspended: false });
  const { nats, tokens, record, stop, directory } = fixture;
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const sandbox = { uid: 'sandbox', ready: false, suspended: true, outdated: true };
  vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  vi.spyOn(kube, 'claim').mockResolvedValue('sandbox');
  const upgrade = vi.spyOn(kube, 'upgrade').mockResolvedValue();
  const mode = vi.spyOn(kube, 'mode').mockResolvedValue();
  const sink = vi.fn().mockResolvedValue(undefined);
  await record('computer.turn_started', turn);
  await record('computer.lost', {});
  await record('computer.claimed', { generation: 2, tokenId: 'token:second' });
  if (!staleTurn) await record('computer.turn_started', { ...turn, turnId: 'current-turn' });
  if (latest === 'computer.resumed') {
    await record('computer.suspended', {});
    await record('computer.resumed', { generation: 2, tokenId: 'token:resume' });
  }
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal);
  function attempted() {
    return upgrade.mock.calls.length > 0 || mode.mock.calls.length > 0;
  }
  try {
    await until(attempted);
    expect(upgrade).toHaveBeenCalledTimes(staleTurn ? 1 : 0);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it.each([['computer.claimed', true], ['computer.claimed', false],
  ['computer.resumed', true], ['computer.resumed', false]] as const)(
  'checks current generation turns before an upgrade (%s, stale turn: %s)',
  checksOnlyCurrentGeneration);

async function resumesOtherComputerDuringSlowUpgrade() {
  const fixture = await computerFixture();
  const { nats, tokens, stop, directory } = fixture;
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  function state(name: string) {
    if (name === 'computer') {
      return Promise.resolve({ uid: 'slow', ready: false, suspended: true, outdated: true });
    }
    return Promise.resolve({ uid: 'other', podUid: 'other-pod', ready: true, suspended: false });
  }
  vi.spyOn(kube, 'state').mockImplementation(state);
  vi.spyOn(kube, 'mode').mockResolvedValue();
  vi.spyOn(kube, 'claim').mockResolvedValue('other');
  let finishUpgrade: () => void = ignored;
  function waitForUpgrade(resolve: () => void) {
    finishUpgrade = resolve;
  }
  const pending = new Promise<void>(waitForUpgrade);
  const upgrade = vi.spyOn(kube, 'upgrade').mockReturnValue(pending);
  const sink = vi.fn().mockResolvedValue(undefined);
  const event = envelope('test', 'computer-other-assistant', 'computer.claimed', {
    assistantId: 'other-assistant', computerId: 'other-computer', generation: 1,
    tokenId: 'token:other' });
  await nats.store.append({ event, expectedSequence: 0 });
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal);
  function otherResumed() {
    return sink.mock.calls.length > 0;
  }
  try {
    await until(otherResumed, 1500);
    expect(upgrade).toHaveBeenCalledTimes(1);
    await delay(550);
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toBe('other-computer');
  } finally {
    stop.abort();
    finishUpgrade();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function ignored(): void {}
it('resumes another computer while one upgrade is still waiting',
  resumesOtherComputerDuringSlowUpgrade);

async function newResumeSkipsBackoff() {
  const fixture = await computerFixture();
  const { nats, tokens, record, stop, directory } = fixture;
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  vi.spyOn(kube, 'state').mockResolvedValue({ uid: 'sandbox', ready: false, suspended: true });
  const mode = vi.spyOn(kube, 'mode').mockRejectedValue(new Error('Unavailable'));
  const sink = vi.fn().mockResolvedValue(undefined);
  const logger = observability.createLogger('retry-test', { level: 'silent' });
  const log = vi.spyOn(logger, 'error');
  vi.spyOn(observability, 'createLogger').mockReturnValue(logger);
  const initialTime = Date.now();
  function clock() { return initialTime; }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal);
  function failedOnce() { return log.mock.calls.length === 1; }
  function triedResume() { return mode.mock.calls.length >= 2; }
  try {
    await until(failedOnce);
    await record('computer.resumed', { generation: 1, tokenId: 'token:resume' });
    await until(triedResume, 1000);
    expect(mode.mock.calls[1]).toEqual(['computer', 'Running']);
    expect(log.mock.calls[1]?.[0]).toMatchObject({ retryInMs: 1000 });
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('lets a new resume event skip the previous retry delay', newResumeSkipsBackoff);

async function capsAndClearsRetryDelay() {
  const fixture = await computerFixture();
  const { nats, tokens, stop, directory } = fixture;
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const sandbox = { uid: 'sandbox', ready: false, suspended: true };
  vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  const mode = vi.spyOn(kube, 'mode').mockRejectedValue(new Error('Unavailable'));
  const sink = vi.fn().mockResolvedValue(undefined);
  const logger = observability.createLogger('retry-test', { level: 'silent' });
  const log = vi.spyOn(logger, 'error');
  vi.spyOn(observability, 'createLogger').mockReturnValue(logger);
  let now = Date.now();
  function clock() { return now; }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal);
  const expectedDelays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
  try {
    for (let index = 0; index < expectedDelays.length; index++) {
      function attempted() { return log.mock.calls.length > index; }
      await until(attempted, 1500);
      expect(log.mock.calls[index]?.[0]).toMatchObject({ retryInMs: expectedDelays[index] });
      now += expectedDelays[index]!;
    }
    mode.mockResolvedValue();
    const beforeSuccess = mode.mock.calls.length;
    function succeeded() { return mode.mock.calls.length > beforeSuccess; }
    await until(succeeded);
    mode.mockRejectedValue(new Error('Unavailable again'));
    sandbox.suspended = false;
    now += 60_000;
    function failedAfterSuccess() { return log.mock.calls.length === expectedDelays.length + 1; }
    await until(failedAfterSuccess);
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({ retryInMs: 1000 });
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('caps retries at 60 seconds and resets the delay after success', capsAndClearsRetryDelay);
