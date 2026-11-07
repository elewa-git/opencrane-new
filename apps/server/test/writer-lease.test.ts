import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { natsFixture, event } from '@opencrane/event-store/testing';
import type { StoredEvent } from '@opencrane/event-store';
import { readComputerControl } from '@opencrane/auth';
import { grantWriter, renewWriter, returnWriter, WriterSlot,
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
    releaseRead?.();
    expect(await claim).toBe(false);
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
    wallNow -= 60_000;
    await slot['refresh']();
    expect(slot['leaseUntil']).toBe(savedDeadline);
    expect(slot.allows(input.leaseId, input.writerSessionId)).toBe(true);
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
