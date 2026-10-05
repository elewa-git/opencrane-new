import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenIssuer } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { expect, it, vi } from 'vitest';
import { SandboxClient } from '../src/kubernetes.ts';
import { history, watchComputers } from '../src/lifecycle.ts';

async function computerFixture(suspended = true) {
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
    expect(mode).toHaveBeenCalledExactlyOnceWith('computer', 'Running');
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
  const fixture = await computerFixture(false);
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
  const sink = vi.fn().mockResolvedValue(undefined);
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
    await delay(550);
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
  const fixture = await computerFixture(false);
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
