import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as observability from '@opencrane/observability';
import { tokenIssuer } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { expect, it, vi } from 'vitest';
import { fakeKubectl } from './fake-kubectl.ts';
import { SandboxClient } from '../src/kubernetes.ts';
import { history, suspendComputer, watchComputers } from '../src/lifecycle.ts';

async function computerFixture({ suspended = true } = {}) {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/computer-idle-`);
  const stop = new AbortController();
  const keyOptions = {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = `${directory}/key.pem`;
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath, issuer: 'https://idle.test/' });
  const subject = 'computer-assistant';
  async function record(type: string, extra: Record<string, unknown>) {
    const rows = await history(nats.store, subject);
    const data = { assistantId: 'assistant', computerId: 'computer', ...extra };
    const event = envelope('test', subject, type, data);
    const result = await nats.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 });
    expect(result.status).toBe('appended');
  }
  await record('computer.claimed', { generation: 1, tokenId: 'token:initial' });
  await record('computer.ready', { generation: 1, podUid: 'old-pod' });
  if (suspended) await record('computer.suspended', {});
  return { nats, directory, stop, tokens, subject, record };
}

async function leavesIdleComputerAlone() {
  const fixture = await computerFixture();
  const { nats, directory, stop, tokens, subject, record } = fixture;
  const initialHead = await nats.store.head();
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const mode = vi.spyOn(kube, 'mode').mockResolvedValue();
  const sandbox = { uid: 'sandbox', podUid: 'new-pod', ready: true, suspended: false };
  const state = vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  const claim = vi.spyOn(kube, 'claim').mockResolvedValue('sandbox');
  const sink = vi.fn().mockResolvedValue(undefined);
  const reads = vi.spyOn(nats.store, 'readStream');
  const subscriptions = vi.spyOn(nats.store, 'subscribe');
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal);
  function appliedSuspension() {
    return mode.mock.calls.length > 0;
  }
  try {
    await until(appliedSuspension);
    reads.mockClear();
    state.mockClear();
    subscriptions.mockClear();
    mode.mockClear();
    await delay(550);
    expect(reads).not.toHaveBeenCalled();
    expect(subscriptions).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    await record('computer.resumed', { generation: 1, tokenId: 'token:resumed' });
    subscriptions.mockClear();
    function credentialsArrived() {
      return sink.mock.calls.length > 0;
    }
    await until(credentialsArrived, 1000);
    expect(mode.mock.calls[0]).toEqual(['computer', 'Running']);
    expect(subscriptions.mock.calls[0]?.[0]).toBe(initialHead + 1);
    async function computerIsReady() {
      const rows = await history(nats.store, subject);
      return rows.at(-1)?.event.type === 'computer.ready';
    }
    await until(computerIsReady, 1000);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('leaves an idle computer alone and handles a wake event on the next poll', leavesIdleComputerAlone);

async function limitsIdleChecksDuringRetries() {
  const fixture = await computerFixture({ suspended: false });
  const { nats, directory, stop, tokens, subject } = fixture;
  const initialTime = Date.now();
  let now = initialTime;
  function clock() {
    return now;
  }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const sandbox = { uid: 'sandbox', podUid: 'old-pod', ready: true, suspended: false };
  const state = vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  vi.spyOn(kube, 'mode').mockResolvedValue();
  const sink = vi.fn().mockRejectedValue(new Error('Temporary credential delivery failure'));
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 1000, stop.signal);
  function firstAttemptFinished() {
    return sink.mock.calls.length > 0;
  }
  async function computerIsSuspended() {
    const rows = await history(nats.store, subject);
    return rows.at(-1)?.event.type === 'computer.suspended';
  }
  try {
    await until(firstAttemptFinished);
    state.mockRejectedValueOnce(new Error('Temporary Kubernetes failure'));
    now = initialTime + 2000;
    const previousAttempts = state.mock.calls.length;
    function nextAttemptFinished() {
      return state.mock.calls.length >= previousAttempts + 1;
    }
    await until(nextAttemptFinished, 1500);
    expect(await computerIsSuspended()).toBe(false);
    now = initialTime + 30_000;
    await until(computerIsSuspended, 1000);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('checks idleness at most every 30 seconds even while retrying Kubernetes',
  limitsIdleChecksDuringRetries);

async function keepsNewMessagesActiveDuringPodReads() {
  const fixture = await computerFixture({ suspended: false });
  const { nats, directory, stop, tokens, subject } = fixture;
  const conversation = 'conversation-chat';
  const created = envelope('test', conversation, 'conversation.created', {
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
  });
  const result = await nats.store.append({ event: created, expectedSequence: 0 });
  if (result.status !== 'appended') throw new Error('Conversation fixture failed');
  const conversationPosition = result.sequence;
  const now = Date.now() + 30_000;
  function clock() {
    return now;
  }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  let posted = false;
  async function readPod() {
    if (!posted) {
      const data = {
        conversationId: 'chat', authorId: 'alice', authorKind: 'human',
        ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text',
      };
      const event = envelope('test', conversation, 'message.posted', data, 'pending-message');
      await nats.store.append({ event, expectedSequence: conversationPosition });
      posted = true;
    }
    return { uid: 'sandbox', podUid: 'old-pod', ready: true, suspended: false };
  }
  vi.spyOn(kube, 'state').mockImplementation(readPod);
  vi.spyOn(kube, 'mode').mockResolvedValue();
  const sink = vi.fn().mockResolvedValue(undefined);
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 1000, stop.signal);
  function computerStayedReady() {
    return sink.mock.calls.length > 0;
  }
  try {
    await until(computerStayedReady, 1500);
    const rows = await history(nats.store, subject);
    expect(rows.at(-1)?.event.type).toBe('computer.ready');
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('keeps a new message active when it arrives during a Kubernetes state read',
  keepsNewMessagesActiveDuringPodReads);

async function limitsReadyPodChecks() {
  const fixture = await computerFixture({ suspended: false });
  const { nats, stop, tokens, directory } = fixture;
  let now = Date.now();
  function clock() {
    return now;
  }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const sandbox = { uid: 'sandbox', podUid: 'old-pod', ready: true, suspended: false };
  const state = vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  vi.spyOn(kube, 'mode').mockResolvedValue();
  const sink = vi.fn().mockResolvedValue(undefined);
  const heads = vi.spyOn(nats.store, 'head');
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 900_000, stop.signal);
  function firstPassFinished() {
    return sink.mock.calls.length > 0;
  }
  try {
    await until(firstPassFinished);
    const passes = heads.mock.calls.length;
    function threeMorePassesFinished() {
      return heads.mock.calls.length >= passes + 3;
    }
    await until(threeMorePassesFinished);
    expect(state).toHaveBeenCalledTimes(1);
    now += 30_000;
    function nextPodCheckFinished() {
      return sink.mock.calls.length >= 2;
    }
    await until(nextPodCheckFinished, 1500);
    expect(state).toHaveBeenCalledTimes(2);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('checks a ready computer at most every 30 seconds while no events arrive', limitsReadyPodChecks);

async function recoversAfterOutsideSuspension() {
  const fixture = await computerFixture({ suspended: false });
  const kubectl = await fakeKubectl();
  const { nats, stop, tokens, directory, record, subject } = fixture;
  let now = Date.now();
  function clock() {
    return now;
  }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  let sandbox: Awaited<ReturnType<typeof kube.state>> = {
    uid: 'sandbox', podUid: 'old-pod', ready: true, suspended: false,
  };
  function readPod() {
    return Promise.resolve(sandbox);
  }
  vi.spyOn(kube, 'state').mockImplementation(readPod);
  vi.spyOn(kube, 'claim').mockResolvedValue('sandbox');
  const sink = vi.fn().mockResolvedValue(undefined);
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 900_000, stop.signal);
  function firstPassFinished() {
    return sink.mock.calls.length > 0;
  }
  async function computerWasLost() {
    const rows = await history(nats.store, subject);
    return rows.at(-1)?.event.type === 'computer.lost';
  }
  async function runningWasPatchedAgain() {
    const commands = await kubectl.commands();
    return commands.length >= 2;
  }
  async function computerIsReadyAgain() {
    const rows = await history(nats.store, subject);
    const latest = rows.at(-1)?.event;
    return latest?.type === 'computer.ready' &&
      typeof latest.data === 'object' && latest.data !== null &&
      Reflect.get(latest.data, 'generation') === 2;
  }
  try {
    await until(firstPassFinished);
    sandbox = { uid: 'sandbox', ready: false, suspended: true };
    now += 30_000;
    await until(computerWasLost, 1500);
    await until(runningWasPatchedAgain, 1500);
    // Reuse the same computer id, as the loss reaction does.
    sandbox = { uid: 'sandbox', ready: false, suspended: false };
    await record('computer.claimed', { generation: 2, tokenId: 'token:second' });
    async function claimWasRestarted() {
      const commands = await kubectl.commands();
      return commands.length >= 3;
    }
    await until(claimWasRestarted, 1500);
    sandbox = { uid: 'sandbox', podUid: 'new-pod', ready: true, suspended: false };
    await until(computerIsReadyAgain, 1500);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await kubectl.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('restarts a computer after an outside suspension and a new claim', recoversAfterOutsideSuspension);

async function correctsSuspendedComputerDrift() {
  const fixture = await computerFixture();
  const kubectl = await fakeKubectl();
  const { nats, stop, tokens, directory } = fixture;
  let now = Date.now();
  function clock() {
    return now;
  }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const sandbox = { uid: 'sandbox', podUid: 'outside-pod', ready: true, suspended: false };
  const state = vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  const sink = vi.fn().mockResolvedValue(undefined);
  const heads = vi.spyOn(nats.store, 'head');
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 900_000, stop.signal);
  async function initialSuspensionApplied() {
    try {
      const commands = await kubectl.commands();
      return commands.length === 1;
    } catch {
      return false;
    }
  }
  try {
    await until(initialSuspensionApplied);
    const initialPasses = heads.mock.calls.length;
    function threeMorePassesFinished() {
      return heads.mock.calls.length >= initialPasses + 3;
    }
    await until(threeMorePassesFinished);
    expect(await kubectl.commands()).toHaveLength(1);
    now += 60_000;
    async function driftWasCorrected() {
      const commands = await kubectl.commands();
      return commands.length >= 2;
    }
    await until(driftWasCorrected, 1500);
    expect(state).toHaveBeenCalledTimes(2);
    expect(sink).not.toHaveBeenCalled();
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await kubectl.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('corrects an outside mode change on a suspended computer after 60 seconds',
  correctsSuspendedComputerDrift);

async function backsOffRefusedModePatches() {
  const fixture = await computerFixture();
  const { nats, directory, stop, tokens } = fixture;
  let now = Date.now();
  function clock() {
    return now;
  }
  vi.spyOn(Date, 'now').mockImplementation(clock);
  const logger = observability.createLogger('retry-test', { level: 'silent' });
  const log = vi.spyOn(logger, 'error');
  vi.spyOn(observability, 'createLogger').mockReturnValue(logger);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const sandbox = { uid: 'sandbox', ready: false, suspended: true };
  vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  const refusal = new Error('ValidatingAdmissionPolicy denied request');
  const mode = vi.spyOn(kube, 'mode').mockRejectedValue(refusal);
  const sink = vi.fn().mockResolvedValue(undefined);
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal);
  function attemptedOnce() {
    return log.mock.calls.length >= 1;
  }
  function attemptedTwice() {
    return log.mock.calls.length >= 2;
  }
  function attemptedThreeTimes() {
    return log.mock.calls.length >= 3;
  }
  try {
    await until(attemptedOnce);
    await delay(600);
    expect(mode).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    now += 1000;
    await until(attemptedTwice, 1000);
    now += 1999;
    await delay(600);
    expect(mode).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    now += 1;
    await until(attemptedThreeTimes, 1000);
    expect(mode).toHaveBeenCalledTimes(3);
    for (const call of log.mock.calls) {
      expect(call[0]).toMatchObject({ computerId: 'computer', err: refusal });
    }
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('backs off refused mode patches and logs the computer once for each retry',
  backsOffRefusedModePatches);

async function replacesRunningComputerAtNextSuspend() {
  const fixture = await computerFixture({ suspended: false });
  const { nats, directory, stop, tokens, subject, record } = fixture;
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const sandbox = { uid: 'sandbox', podUid: 'old-pod', ready: true,
    suspended: false, outdated: true };
  vi.spyOn(kube, 'state').mockResolvedValue(sandbox);
  const mode = vi.spyOn(kube, 'mode').mockResolvedValue();
  const replace = vi.spyOn(kube, 'replace').mockResolvedValue();
  vi.spyOn(kube, 'claim').mockResolvedValue('new-sandbox');
  const sink = vi.fn().mockResolvedValue(undefined);
  const work = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal);
  function computerStillRunning() {
    return sink.mock.calls.length > 0;
  }
  function computerReplaced() {
    return mode.mock.calls.length > 0;
  }
  try {
    await until(computerStillRunning);
    expect(replace).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
    const rows = await history(nats.store, subject);
    const ready = rows.at(-1)!.event;
    const turn = { conversationId: 'chat', turnId: 'turn', threadId: 'thread',
      requesterId: 'alice', task: 'chat_turn' };
    await record('computer.turn_started', turn);
    const busy = await suspendComputer(nats.store, {
      assistantId: 'assistant', computerId: 'computer', latest: ready, ready,
    });
    expect(busy.id).toBe(ready.id);
    expect(replace).not.toHaveBeenCalled();
    await record('computer.turn_closed', { ...turn, status: 'completed' });
    await suspendComputer(nats.store, {
      assistantId: 'assistant', computerId: 'computer', latest: ready, ready,
    });
    await until(computerReplaced, 1500);
    expect(replace).toHaveBeenCalledExactlyOnceWith('computer', 'assistant');
    expect(mode).toHaveBeenCalledExactlyOnceWith('computer', 'Suspended');
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('keeps an outdated running computer until its next committed suspend',
  replacesRunningComputerAtNextSuspend);
