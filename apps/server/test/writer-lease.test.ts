import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { natsFixture, event } from '@opencrane/event-store/testing';
import type { StoredEvent } from '@opencrane/event-store';
import { readComputerControl } from '@opencrane/auth';
import { endWriter, grantWriter, renewWriter, returnWriter, WriterSlot,
  writerProxyInstanceId } from '../src/computers/writer-lease.ts';
import { viewerStream, writerStream } from '../src/computers/rfb.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;
afterEach(async function closeFixture() { vi.restoreAllMocks(); await fixture?.close(); });
async function accessAllowed() {}

const binding = { assistantId: 'assistant', computerId: 'desktop', generation: 1,
  podUid: 'pod', conversationId: 'chat', requesterId: 'alice',
  requesterEventId: 'request', takeoverId: 'takeover', leaseId: 'lease',
  affectedTurnIds: [] };

async function setup(quiet = true) {
  fixture = await natsFixture();
  const ready = { ...event('ready', 'computer-assistant', 'computer.ready'),
    data: { assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: 'pod' } };
  const requested = { ...event('requested', 'computer-assistant', 'takeover.requested'),
    commandId: 'request-command', data: { ...binding, reason: 'requester_requested' } };
  const proofBinding = { assistantId: binding.assistantId, computerId: binding.computerId,
    generation: binding.generation, podUid: binding.podUid,
    takeoverId: binding.takeoverId, affectedTurnIds: binding.affectedTurnIds };
  const pausing = { ...event('pausing', 'computer-assistant', 'takeover.pausing'),
    data: { ...proofBinding, bridgeEpoch: 'bridge', supervisorEpoch: 'supervisor',
      executionProof: 'exited', quietProof: 'unavailable' } };
  const paused = { ...event('paused', 'computer-assistant', 'takeover.paused'),
    data: { ...proofBinding, bridgeEpoch: 'bridge', supervisorEpoch: 'supervisor',
      quietProof: 'complete' } };
  if (quiet) {
    await fixture.seed([ready, requested, pausing, paused]);
  } else {
    await fixture.seed([ready, requested]);
  }
  const { affectedTurnIds: _turns, ...owner } = binding;
  const input = { ...owner, commandId: 'start-command', writerSessionId: 'socket',
    proxyInstanceId: writerProxyInstanceId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    originalExpiresAt: new Date(Date.now() + 120_000).toISOString() };
  return { store: fixture.store, input };
}
function returnInput(input: Awaited<ReturnType<typeof setup>>['input']) {
  return { assistantId: input.assistantId, computerId: input.computerId,
    generation: input.generation, podUid: input.podUid,
    conversationId: input.conversationId, requesterId: input.requesterId,
    requesterEventId: input.requesterEventId, takeoverId: input.takeoverId,
    leaseId: input.leaseId, writerSessionId: input.writerSessionId,
    commandId: 'return-command' };
}

async function grantsOnlyAfterQuietProof() {
  const { store, input } = await setup();
  const started = await grantWriter(store, 'test', input, accessAllowed);
  expect(started.phase).toBe('started');
  expect((await readComputerControl(store, 'test', 'assistant'))?.phase).toBe('started');
  await expect(grantWriter(store, 'test', { ...input, commandId: 'second' }, accessAllowed))
    .rejects.toThrow();
}
it('saves one exclusive writer lease after quiet proof', grantsOnlyAfterQuietProof);

async function refusesChangedStartRetries() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const changedExpiry = { ...input,
    expiresAt: new Date(Date.parse(input.expiresAt) - 1000).toISOString() };
  const changedOriginal = { ...input,
    originalExpiresAt: new Date(Date.parse(input.originalExpiresAt) - 1000).toISOString() };
  await expect(grantWriter(store, 'test', changedExpiry, accessAllowed))
    .rejects.toThrow('Control conflict');
  await expect(grantWriter(store, 'test', changedOriginal, accessAllowed))
    .rejects.toThrow('Control conflict');
}
it('refuses a start command id reused with changed expiry fields', refusesChangedStartRetries);

async function refusesBeforeQuietProof() {
  const { store, input } = await setup(false);
  await expect(grantWriter(store, 'test', input, accessAllowed)).rejects.toThrow();
  expect((await readComputerControl(store, 'test', 'assistant'))?.phase).toBe('requested');
}
it('refuses a writer before quiet proof is saved', refusesBeforeQuietProof);

async function returnsOnceAndCannotRenew() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const command = returnInput(input);
  const returned = await returnWriter(store, 'test', command, accessAllowed);
  expect(returned.phase).toBe('returning');
  expect(await returnWriter(store, 'test', command, accessAllowed)).toEqual(returned);
  await expect(renewWriter(store, 'test', { ...input, commandId: 'renew-command',
    writerSessionId: input.writerSessionId,
    proxyInstanceId: input.proxyInstanceId, originalExpiresAt: input.originalExpiresAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }, accessAllowed)).rejects.toThrow();
}
it('saves Return once and refuses renewal afterwards', returnsOnceAndCannotRenew);

async function refusesInputOutsideTheSingleSlot() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const forwarded: Buffer[] = [];
  const recordingSocket = new PassThrough();
  function record(bytes: Buffer) { forwarded.push(bytes); }
  function send(bytes: Buffer) { recordingSocket.write(bytes); }
  recordingSocket.on('data', record);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  const second = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await second.claim()).toBe(false);
  const accepted = writerStream(slot, 'lease', 'socket', send);
  accepted(Buffer.from('RFB 003.008\n'));
  accepted(Buffer.from([1]));
  accepted(Buffer.from([1]));
  accepted(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]));
  expect(forwarded).toHaveLength(4);
  recordingSocket.destroy();
  accepted(Buffer.from([6, 0, 0, 0]));
  expect(forwarded).toHaveLength(4);
  slot.close();
  accepted(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]));
  expect(forwarded).toHaveLength(4);
}
it('refuses clipboard and input after the writer slot closes', refusesInputOutsideTheSingleSlot);

function viewersCannotSendInput() {
  for (const input of [
    Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]),
    Buffer.from([5, 1, 0, 1, 0, 1]),
    Buffer.from([6, 0, 0, 0]),
    Buffer.from([7, 0, 0, 0]),
  ]) {
    const forwarded: Buffer[] = [];
    let refused = false;
    function record(bytes: Buffer) { forwarded.push(bytes); }
    function refuse() { refused = true; }
    const accept = viewerStream(record, refuse);
    accept(Buffer.from('RFB 003.008\n'));
    accept(Buffer.from([1]));
    accept(Buffer.from([1]));
    accept(input);
    expect(refused).toBe(true);
    expect(forwarded).toHaveLength(3);
  }
}
it('keeps viewer input, clipboard and file extensions read-only', viewersCannotSendInput);

async function rejectsStaleWriter() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const wrongOwner = new WriterSlot(store, 'test', { ...input, requesterId: 'bob' }, accessAllowed);
  expect(await wrongOwner.claim()).toBe(false);
  const oldGeneration = new WriterSlot(store, 'test', { ...input, generation: 2 }, accessAllowed);
  expect(await oldGeneration.claim()).toBe(false);
  const oldProxy = new WriterSlot(store, 'test', { ...input, proxyInstanceId: 'old' },
    accessAllowed);
  expect(await oldProxy.claim()).toBe(false);
  function noAccess(): Promise<void> { return Promise.reject(new Error('Unavailable')); }
  const unavailable = new WriterSlot(store, 'test', input, noAccess);
  expect(await unavailable.claim()).toBe(false);
  await returnWriter(store, 'test', returnInput(input), accessAllowed);
  const afterReturn = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await afterReturn.claim()).toBe(false);
}
it('refuses a different requester, old generation, outage and returned lease', rejectsStaleWriter);

async function renewsOnlyTheLiveSlot() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  const renewed = await renewWriter(store, 'test', { ...input,
    commandId: 'renew-command', expiresAt: new Date(Date.now() + 90_000).toISOString(),
  }, accessAllowed);
  expect(renewed.phase).toBe('renewed');
  await expect(renewWriter(store, 'test', { ...input, commandId: 'too-late',
    expiresAt: new Date(Date.now() + 121_000).toISOString(),
  }, accessAllowed)).rejects.toThrow();
  slot.close();
  await expect(renewWriter(store, 'test', { ...input, commandId: 'disconnected',
    expiresAt: new Date(Date.now() + 100_000).toISOString(),
  }, accessAllowed)).rejects.toThrow();
  const reopened = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await reopened.claim()).toBe(false);
}
it('renews only a live slot within the original deadline', renewsOnlyTheLiveSlot);

async function refusesChangedRenewalRetries() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  try {
    const renewal = { ...input, commandId: 'renew-command',
      expiresAt: new Date(Date.now() + 90_000).toISOString() };
    await renewWriter(store, 'test', renewal, accessAllowed);
    const changedExpiry = { ...renewal,
      expiresAt: new Date(Date.parse(renewal.expiresAt) - 1000).toISOString() };
    const changedOriginal = { ...renewal,
      originalExpiresAt: new Date(Date.parse(renewal.originalExpiresAt) - 1000).toISOString() };
    await expect(renewWriter(store, 'test', changedExpiry, accessAllowed))
      .rejects.toThrow('Control conflict');
    await expect(renewWriter(store, 'test', changedOriginal, accessAllowed))
      .rejects.toThrow('Control conflict');
  } finally {
    slot.close();
  }
}
it('refuses a renewal command id reused with changed expiry fields',
  refusesChangedRenewalRetries);

async function refusesAccessRemovedDuringComputerRead() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  let releaseRead: (() => void) | undefined;
  let signalRead: (() => void) | undefined;
  const readHeld = new Promise<void>(function captureSignal(resolve) { signalRead = resolve; });
  const readReleased = new Promise<void>(function captureRelease(resolve) {
    releaseRead = resolve;
  });
  const originalRead = store.readStream.bind(store);
  let readCount = 0;
  async function* delayedRead(rows: AsyncIterable<StoredEvent>) {
    signalRead?.();
    await readReleased;
    for await (const row of rows) yield row;
  }
  function readStream(subject: string, sequence?: number, deadline?: number,
    includeConversationCloses?: boolean) {
    readCount += 1;
    const rows = originalRead(subject, sequence, deadline, includeConversationCloses);
    if (readCount === 2) return delayedRead(rows);
    return rows;
  }
  vi.spyOn(store, 'readStream').mockImplementation(readStream);
  let removed = false;
  let accessChecks = 0;
  function checkAccess(): Promise<void> {
    accessChecks += 1;
    if (removed) return Promise.reject(new Error('Member removed'));
    return Promise.resolve();
  }
  const slot = new WriterSlot(store, 'test', input, checkAccess);
  try {
    const claim = slot.claim();
    await readHeld;
    removed = true;
    const removedAt = performance.now();
    releaseRead?.();
    expect(await claim).toBe(false);
    expect(performance.now() - removedAt).toBeLessThan(2_000);
    expect(accessChecks).toBeGreaterThanOrEqual(2);
    expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
  } finally {
    releaseRead?.();
    slot.close();
  }
}
it('refuses input when access is removed during a delayed computer read',
  refusesAccessRemovedDuringComputerRead);

async function keepsLeaseExpiryAfterClockMovesBack() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const wallStart = Date.now();
  let wallNow = wallStart;
  vi.spyOn(Date, 'now').mockImplementation(function clockTime() { return wallNow; });
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  try {
    expect(await slot.claim()).toBe(true);
    const savedDeadline = slot['leaseUntil'];
    let monotonicNow = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(function monotonicTime() {
      return monotonicNow;
    });
    wallNow -= 60_000;
    await slot['refresh']();
    expect(slot['leaseUntil']).toBe(savedDeadline);
    expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(true);
    monotonicNow = savedDeadline + 1;
    expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
  } finally {
    slot.close();
  }
}
it('does not extend a saved lease after the wall clock moves backwards',
  keepsLeaseExpiryAfterClockMovesBack);

async function refusesAnExpiredSlotBeforeApplyingANewExpiry() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  let monotonicNow = 1000;
  vi.spyOn(performance, 'now').mockImplementation(function monotonicTime() {
    return monotonicNow;
  });
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  try {
    expect(await slot.claim()).toBe(true);
    monotonicNow += 61_000;
    const laterExpiry = new Date(Date.now() + 90_000).toISOString();
    expect(function applyLaterExpiry() {
      slot['updateDeadlines'](laterExpiry, input.originalExpiresAt);
    }).toThrow('Control unavailable');
    expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
  } finally {
    slot.close();
  }
}
it('does not revive an expired slot when a later saved expiry arrives',
  refusesAnExpiredSlotBeforeApplyingANewExpiry);

async function cancelsQueuedInputAtLeaseExpiry() {
  const { store, input } = await setup();
  input.expiresAt = new Date(Date.now() + 1_200).toISOString();
  await grantWriter(store, 'test', input, accessAllowed);
  let signalRefresh: (() => void) | undefined;
  let releaseRefresh: (() => void) | undefined;
  const refreshHeld = new Promise<void>(function captureRefresh(resolve) {
    signalRefresh = resolve;
  });
  const refreshReleased = new Promise<void>(function captureRelease(resolve) {
    releaseRefresh = resolve;
  });
  let accessChecks = 0;
  async function checkAccess() {
    accessChecks += 1;
    if (accessChecks === 3) {
      signalRefresh?.();
      await refreshReleased;
    }
  }
  const slot = new WriterSlot(store, 'test', input, checkAccess);
  const forwarded: string[] = [];
  let releaseDelivery: (() => void) | undefined;
  let deliverySignal: AbortSignal | undefined;
  function queueDelivery(bytes: Buffer, signal: AbortSignal) {
    deliverySignal = signal;
    return new Promise<void>(function holdDelivery(resolve) {
      releaseDelivery = function deliver() {
        if (!signal.aborted) forwarded.push(bytes.toString('hex'));
        resolve();
      };
    });
  }
  try {
    expect(await slot.claim()).toBe(true);
    const refresh = slot['refresh']();
    await refreshHeld;
    const untilQueue = slot['leaseUntil'] - performance.now() - 100;
    await wait(Math.max(0, untilQueue));
    expect(slot.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), queueDelivery)).toBe(true);
    await wait(Math.max(0, slot['leaseUntil'] - performance.now() + 100));
    expect(deliverySignal?.aborted).toBe(true);
    releaseDelivery?.();
    await slot.drain();
    expect(forwarded).toEqual([]);
    releaseRefresh?.();
    await refresh;
  } finally {
    releaseDelivery?.();
    releaseRefresh?.();
    slot.close();
  }
}
it('aborts a key queued just before lease expiry before it can be forwarded',
  cancelsQueuedInputAtLeaseExpiry);

async function cancelsQueuedInputWhileRefreshIsStalled() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  let signalRefresh: (() => void) | undefined;
  let releaseRefresh: (() => void) | undefined;
  const refreshHeld = new Promise<void>(function captureRefresh(resolve) {
    signalRefresh = resolve;
  });
  const refreshReleased = new Promise<void>(function captureRelease(resolve) {
    releaseRefresh = resolve;
  });
  let accessChecks = 0;
  async function checkAccess() {
    accessChecks += 1;
    if (accessChecks === 3) {
      signalRefresh?.();
      await refreshReleased;
      throw new Error('Member removed');
    }
  }
  const slot = new WriterSlot(store, 'test', input, checkAccess);
  const forwarded: string[] = [];
  let releaseDelivery: (() => void) | undefined;
  let deliverySignal: AbortSignal | undefined;
  function queueDelivery(bytes: Buffer, signal: AbortSignal) {
    deliverySignal = signal;
    return new Promise<void>(function holdDelivery(resolve) {
      releaseDelivery = function deliver() {
        if (!signal.aborted) forwarded.push(bytes.toString('hex'));
        resolve();
      };
    });
  }
  try {
    expect(await slot.claim()).toBe(true);
    expect(slot.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), queueDelivery)).toBe(true);
    const refresh = slot['refresh']();
    await refreshHeld;
    await wait(Math.max(0, slot['permissionUntil'] - performance.now() + 100));
    expect(deliverySignal?.aborted).toBe(true);
    releaseDelivery?.();
    await slot.drain();
    expect(forwarded).toEqual([]);
    releaseRefresh?.();
    await refresh;
  } finally {
    releaseDelivery?.();
    releaseRefresh?.();
    slot.close();
  }
}
it('aborts queued input while a revocation check is stalled',
  cancelsQueuedInputWhileRefreshIsStalled);

async function closesInputWhenReturnCannotBeSaved() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  vi.spyOn(store, 'append').mockResolvedValue({ status: 'unavailable', cause: 'fixture' });
  await expect(returnWriter(store, 'test', returnInput(input), accessAllowed))
    .rejects.toThrow('Control unavailable');
  expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
  const reopened = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await reopened.claim()).toBe(false);
}
it('closes input on a Return append outage and refuses another socket',
  closesInputWhenReturnCannotBeSaved);

async function closesAfterDrainingTheLastInput() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  const sent: string[] = [];
  let cancelled = 0;
  const pending: Array<() => void> = [];
  function queueInput(bytes: Buffer, signal: AbortSignal) {
    return new Promise<void>(function waitForDelivery(resolve) {
      signal.addEventListener('abort', function cancel() { cancelled += 1; resolve(); },
        { once: true });
      pending.push(function deliver() {
        if (!signal.aborted) sent.push(bytes.toString('hex'));
        resolve();
      });
    });
  }
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
  function immediateInput(bytes: Buffer) { sent.push(bytes.toString('hex')); }
  slot.send(key, immediateInput);
  slot.send(key, queueInput);
  await returnWriter(store, 'test', returnInput(input), accessAllowed);
  let drained = false;
  async function drain() {
    expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
    await slot.drain();
    drained = true;
    return 'pod-drain';
  }
  const ending = endWriter(store, 'test', { ...returnInput(input),
    commandId: 'end-command', reason: 'returned' }, drain, accessAllowed);
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(slot.send(key, queueInput)).toBe(false);
  pending[0]?.();
  const ended = await ending;
  expect(drained).toBe(true);
  expect(sent).toHaveLength(1);
  expect(cancelled).toBe(1);
  expect(ended.phase).toBe('ended');
  expect(ended.closureReceiptId).toBe('pod-drain');
  expect(ended.canStartNewWork).toBe(true);
  await readComputerControl(store, 'test', input.assistantId);
  await readComputerControl(store, 'test', input.assistantId);
  expect(sent).toHaveLength(1);
}
it('closes input before draining and accounts for the last accepted key',
  closesAfterDrainingTheLastInput);

async function keepsUnknownClosurePaused() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  function unavailableDrain() { return Promise.resolve(undefined); }
  const unknown = await endWriter(store, 'test', { ...returnInput(input),
    commandId: 'unknown-command', reason: 'disconnect' }, unavailableDrain, accessAllowed);
  expect(unknown.phase).toBe('closure_unknown');
  expect(unknown.canStartNewWork).toBeUndefined();
  expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
  const second = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await second.claim()).toBe(false);
  expect((await readComputerControl(store, 'test', 'assistant'))?.phase).toBe('closure_unknown');
}
it('marks an unproved disconnect unknown and leaves agent work paused',
  keepsUnknownClosurePaused);

async function resolvesEndAfterLostReadback(proved: boolean) {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  if (proved) {
    const slot = new WriterSlot(store, 'test', input, accessAllowed);
    expect(await slot.claim()).toBe(true);
  }
  const command = { ...returnInput(input), commandId: 'end-after-lost-reply',
    reason: proved ? 'expired' : 'disconnect' };
  const expectedPhase = proved ? 'ended' : 'closure_unknown';
  let proofCalls = 0;
  function proveDrain() {
    proofCalls += 1;
    return Promise.resolve('pod-drain');
  }
  const originalAppend = store.append.bind(store);
  const originalRead = store.readStream.bind(store);
  let loseReadback = false;
  let appendCalls = 0;
  async function append(commandToSave: Parameters<typeof store.append>[0]) {
    appendCalls += 1;
    const result = await originalAppend(commandToSave);
    if (result.status === 'appended') loseReadback = true;
    return result;
  }
  async function* readStream(subject: string, sequence?: number, deadline?: number,
    includeConversationCloses?: boolean) {
    if (loseReadback) {
      loseReadback = false;
      throw new Error('Readback lost');
    }
    const rows = originalRead(subject, sequence, deadline, includeConversationCloses);
    for await (const row of rows) yield row;
  }
  vi.spyOn(store, 'append').mockImplementation(append);
  vi.spyOn(store, 'readStream').mockImplementation(readStream);
  await expect(endWriter(store, 'test', command, proveDrain, accessAllowed))
    .rejects.toThrow('Readback lost');
  const saved = await readComputerControl(store, 'test', input.assistantId);
  expect(saved?.phase).toBe(expectedPhase);
  const resolved = await endWriter(store, 'test', command, proveDrain, accessAllowed);
  expect(resolved).toEqual(saved);
  expect(appendCalls).toBe(1);
  expect(proofCalls).toBe(proved ? 1 : 0);
  await expect(endWriter(store, 'test', { ...command, reason: 'revoked' },
    proveDrain, accessAllowed)).rejects.toThrow('Control conflict');
  expect(appendCalls).toBe(1);
}
it.each([true, false])('resolves a %s proof end after its saved reply is lost',
  resolvesEndAfterLostReadback);

async function closesOnFailedEndAppend() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  function drain() { return Promise.resolve('pod-drain'); }
  vi.spyOn(store, 'append').mockResolvedValue({ status: 'unavailable', cause: 'fixture' });
  await expect(endWriter(store, 'test', { ...returnInput(input),
    commandId: 'end-command', reason: 'expired' }, drain, accessAllowed))
    .rejects.toThrow('Control unavailable');
  expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
}
it('keeps input shut if saving expiry fails', closesOnFailedEndAppend);

async function completesSavedReturnOnlyWithProof() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  await returnWriter(store, 'test', returnInput(input), accessAllowed);
  function drain() { return Promise.resolve('pod-drain'); }
  const ended = await endWriter(store, 'test', { ...returnInput(input),
    commandId: 'end-command', reason: 'returned' }, drain, accessAllowed);
  expect(ended.phase).toBe('ended');
  expect(ended.reason).toBe('returned');
  expect(ended.canStartNewWork).toBe(true);
  const oldSocket = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await oldSocket.claim()).toBe(false);
}
it('completes Return after the saved request and a Pod drain receipt',
  completesSavedReturnOnlyWithProof);

async function foreignReturnCannotCloseCurrentInput() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  await expect(returnWriter(store, 'test', { ...returnInput(input), requesterId: 'bob' },
    accessAllowed)).rejects.toThrow('Control conflict');
  expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(true);
  slot.close();
}
it('does not let a different requester close the current writer',
  foreignReturnCannotCloseCurrentInput);

async function rejectsOldEndRecordsAsProof() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  await fixture.seed([{ ...event('historical-end', 'computer-assistant', 'takeover.ended'),
    data: { assistantId: input.assistantId, computerId: input.computerId,
      endedBy: input.requesterId } }]);
  const replayed = await readComputerControl(store, 'test', input.assistantId);
  expect(replayed?.phase).toBe('unverified');
  const oldSocket = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await oldSocket.claim()).toBe(false);
}
it('never treats a historical end as fresh closure proof', rejectsOldEndRecordsAsProof);

async function replacementGenerationClosesOnlyItsOwnWriter() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  const viewerBytes: Buffer[] = [];
  function view(bytes: Buffer) { viewerBytes.push(bytes); }
  function refuseViewer() { throw new Error('Viewer closed'); }
  const viewer = viewerStream(view, refuseViewer);
  await fixture.seed([{ ...event('replacement', 'computer-assistant', 'computer.ready'),
    data: { assistantId: input.assistantId, computerId: input.computerId,
      generation: 2, podUid: 'replacement' } }]);
  await slot['refresh']();
  expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
  viewer(Buffer.from('RFB 003.008\n'));
  expect(viewerBytes).toHaveLength(1);
  const oldSocket = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await oldSocket.claim()).toBe(false);
}
it('closes the old generation without closing a separate read-only viewer',
  replacementGenerationClosesOnlyItsOwnWriter);

async function restartNeverReusesTheSavedLease() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  let proofCalls = 0;
  function proveDrain() {
    proofCalls += 1;
    return Promise.resolve('untrusted-after-restart');
  }
  const unknown = await endWriter(store, 'test', { ...returnInput(input),
    commandId: 'restart-command', reason: 'proxy_failure' }, proveDrain, accessAllowed);
  expect(unknown.phase).toBe('closure_unknown');
  expect(proofCalls).toBe(0);
  expect((await readComputerControl(store, 'test', input.assistantId))?.phase)
    .toBe('closure_unknown');
  const oldSocket = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await oldSocket.claim()).toBe(false);
}
it('marks a saved lease unknown after local writer state is lost',
  restartNeverReusesTheSavedLease);

async function recordsRevocationAfterAccessIsLost() {
  const { store, input } = await setup();
  await grantWriter(store, 'test', input, accessAllowed);
  const slot = new WriterSlot(store, 'test', input, accessAllowed);
  expect(await slot.claim()).toBe(true);
  function removedAccess(): Promise<void> {
    return Promise.reject(new Error('Member removed'));
  }
  function proveDrain() { return Promise.resolve('pod-drain'); }
  const ended = await endWriter(store, 'test', { ...returnInput(input),
    commandId: 'revoked-command', reason: 'revoked' }, proveDrain, removedAccess);
  expect(ended.phase).toBe('ended');
  expect(ended.reason).toBe('revoked');
  expect(ended.canStartNewWork).toBe(false);
  expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(false);
}
it('records a proved revocation without the former requester access',
  recordsRevocationAfterAccessIsLost);
