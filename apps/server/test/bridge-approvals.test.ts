import { parseEventByType } from '@opencrane/events';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history, readApproval, decideApproval } from '@opencrane/models';
import { createEventStore } from '@opencrane/event-store';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';
import { bridgeApprovals } from '../src/chat/bridge-approvals.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
const approvalId = 'a'.repeat(64);
const request = {
  approvalId, assistantId: 'assistant', conversationId: 'chat', turnId: 'turn',
  requesterId: 'alice', tool: 'write', serverId: 'fixture', connectionId: 'installed',
  toolRevision: approvalId, schemaDigest: approvalId, profile: 'none', policySequence: 0,
  digestVersion: 'lossless-json-v1', argumentsDigest: approvalId,
  expiresAt: '2099-01-01T00:00:00.000Z', stepUp: false,
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', keyId: 'key:fixture', reviewDigest: approvalId,
};
const waiting = { type: 'approval_waiting', approvalId, conversationId: 'chat', turnId: 'turn' };

async function setup() {
  nats = await shortDuplicateWindowFixture();
}
async function cleanup() {
  vi.restoreAllMocks();
  await nats.close();
}
beforeEach(setup);
afterEach(cleanup);

async function append(subject: string, type: string, data: unknown) {
  const expectedSequence = await nats.store.head(subject);
  const event = envelope('test', subject, type, data);
  const command = { event, expectedSequence };
  expect((await nats.store.append(command)).status).toBe('appended');
}
async function seedRequest(overrides = {}) {
  await append(`approval-${approvalId}`, 'tool.approval_requested', { ...request, ...overrides });
}
async function seedLiveTurn() {
  await append('conversation-chat', 'agent.turn_started', {
    conversationId: 'chat', turnId: 'turn', assistantId: 'assistant', threadId: 'thread',
  });
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(checkedAt) + 300_000).toISOString();
  await append('mcp-fixture', 'mcp.server_discovered', {
    checkedAt, expiresAt,
    serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    schemaDigest: catalogueDigest([]), toolCount: 0, tools: [],
  });
  await append('mcp-fixture', 'mcp.server_published', {
    serverId: 'fixture', publishedBy: 'alice',
  });
  return nats.store.head('mcp-fixture');
}
function watcher(assistantId = 'assistant') {
  const send = vi.fn();
  const socket: { readyState: WebSocket['readyState']; send: typeof send } = {
    readyState: WebSocket.OPEN, send,
  };
  const approvals = bridgeApprovals(nats.store, 'test', assistantId, socket);
  return { approvals, send, socket };
}
async function poll(approvals: ReturnType<typeof bridgeApprovals>) {
  approvals.poll(await nats.store.head());
  await approvals.settled();
}

async function ignoresWrongBinding(field: string) {
  await seedRequest({ [field]: field === 'approvalId' ? 'b'.repeat(64) : 'other' });
  const { approvals, send } = watcher();
  const head = await nats.store.head();
  expect(approvals.receive(waiting)).toBe(true);
  await poll(approvals);
  expect(send).not.toHaveBeenCalled();
  expect(approvals.size).toBe(0);
  expect(await nats.store.head()).toBe(head);
}
it.each(['assistantId', 'conversationId', 'turnId', 'approvalId'])(
  'ignores a waiting signal with the wrong %s without changing events', ignoresWrongBinding,
);
function ignoresInvalidId(id: string) {
  const { approvals } = watcher();
  expect(approvals.receive({ ...waiting, approvalId: id })).toBe(true);
  expect(approvals.size).toBe(0);
}
it.each(['short', 'g'.repeat(64), 'A'.repeat(64)])(
  'ignores invalid approval id %s', ignoresInvalidId,
);

async function sendsSavedState(state: string) {
  const policySequence = await seedLiveTurn();
  await seedRequest({ policySequence });
  let type = `approval.${state}`;
  let data: unknown = { approvalId };
  if (state === 'denied' || state === 'approved') {
    type = 'approval.decided';
    data = { approvalId, decidedBy: 'alice', decision: state === 'approved' ? 'approved' : 'rejected' };
  }
  if (state === 'outcome_unknown') {
    type = 'approval.used';
    data = { approvalId, permitId: 'permit' };
  }
  await append(`approval-${approvalId}`, type, data);
  const first = watcher();
  first.approvals.receive(waiting);
  first.approvals.receive(waiting);
  await poll(first.approvals);
  await poll(first.approvals);
  expect(first.send).toHaveBeenCalledTimes(1);
  expect(first.send).toHaveBeenCalledWith(JSON.stringify({
    type: 'approval_settled', approvalId, state,
  }));
  const second = watcher();
  second.approvals.receive(waiting);
  await poll(second.approvals);
  expect(second.send).toHaveBeenCalledTimes(1);
}
it.each(['approved', 'denied', 'expired', 'cancelled', 'outcome_unknown'])(
  'sends the saved %s state once, including after reconnect', sendsSavedState,
);
async function checksChangedConversation(subject: string) {
  await seedRequest({ policySequence: await seedLiveTurn() });
  const { approvals, send } = watcher();
  approvals.receive(waiting);
  await poll(approvals);
  expect(send).not.toHaveBeenCalled();
  const read = vi.spyOn(nats.store, 'readStream');
  await poll(approvals);
  expect(read).not.toHaveBeenCalled();
  if (subject === 'stop') {
    await append('conversation-chat', 'agent.turn_stop_requested', {
      conversationId: 'chat', turnId: 'turn', requestedBy: 'alice',
    });
  } else {
    await append(subject, 'conversation.closed', { conversationId: 'chat', closedBy: 'alice' });
  }
  await poll(approvals);
  expect(send).toHaveBeenCalledWith(JSON.stringify({
    type: 'approval_settled', approvalId, state: 'cancelled',
  }));
}
it.each(['stop', 'conversation-chat', 'participation-chat'])(
  'reads only changed streams and cancels after %s', checksChangedConversation);

async function retriesFailedRead() {
  await seedRequest({ policySequence: await seedLiveTurn() });
  const { approvals, send } = watcher();
  approvals.receive(waiting);
  await poll(approvals);
  await append(`approval-${approvalId}`, 'approval.decided', {
    approvalId, decidedBy: 'alice', decision: 'rejected',
  });
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementationOnce(failedRead);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const failedAt = Date.now();
    await poll(approvals);
    expect(send).not.toHaveBeenCalled();
    read.mockClear();
    await poll(approvals);
    expect(read).not.toHaveBeenCalled();
    vi.setSystemTime(failedAt + 1000);
    await poll(approvals);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
}
it('wakes when an approval changes and retries a failed read without another event',
  retriesFailedRead);

async function checksExpiry() {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await seedRequest({ expiresAt, policySequence: await seedLiveTurn() });
  const { approvals, send } = watcher();
  approvals.receive(waiting);
  await poll(approvals);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.parse(expiresAt));
    await poll(approvals);
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: 'approval_settled', approvalId, state: 'expired',
    }));
  } finally {
    vi.useRealTimers();
  }
}
it('expires a requested approval without any new event',
  checksExpiry);

async function checksIndependentReads() {
  await seedRequest();
  await append(`approval-${approvalId}`, 'approval.cancelled', { approvalId });
  const { approvals, send } = watcher();
  const blocked = 'b'.repeat(64);
  const gate = Promise.withResolvers<number>();
  const head = nats.store.head.bind(nats.store);
  function readHead(subject?: string, deadline?: number) {
    if (subject === `approval-${blocked}`) return gate.promise;
    return head(subject, deadline);
  }
  const reads = vi.spyOn(nats.store, 'head').mockImplementation(readHead);
  approvals.receive({ ...waiting, approvalId: blocked });
  approvals.receive(waiting);
  approvals.poll(await nats.store.head());
  approvals.receive({ ...waiting, approvalId: blocked });
  approvals.poll(await nats.store.head());
  try {
    const { until } = await import('@opencrane/authz/testing');
    function replied() { return send.mock.calls.length === 1; }
    await until(replied);
    const blockedCalls = reads.mock.calls.filter(isBlockedCall);
    expect(blockedCalls).toHaveLength(1);
  } finally {
    gate.resolve(0);
    await approvals.settled();
  }
  function isBlockedCall(call: Parameters<typeof nats.store.head>) {
    return call[0] === `approval-${blocked}`;
  }
}
it('does not wait for one approval before checking another, or start two reads for one',
  checksIndependentReads);

async function boundsWaitingEntries() {
  const { approvals, socket, send } = watcher();
  expect(approvals.receive({ ...waiting, state: 'approved' })).toBe(true);
  expect(approvals.receive({ type: 'agent.turn_started' })).toBe(false);
  expect(approvals.size).toBe(0);
  for (let index = 0; index < 65; index++) {
    const id = index.toString(16).padStart(64, '0');
    approvals.receive({ ...waiting, approvalId: id });
  }
  expect(approvals.size).toBe(64);
  socket.readyState = WebSocket.CLOSED;
  await poll(approvals);
  expect(approvals.size).toBe(0);
  const refusal = {
    type: 'approval_settled', approvalId: '40'.padStart(64, '0'), state: 'outcome_unknown',
  };
  expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(refusal));
}
it('bounds waiting entries, refuses unknown fields and forgets a closed link',
  boundsWaitingEntries);

async function acceptsSocketSignals() {
  const { connectBridge } = await import('../src/chat/bridge.ts');
  const { conversationKeys } = await import('../src/chat/keys.ts');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const resume = Promise.withResolvers<unknown>();
  function receiveResume(raw: unknown) {
    resume.resolve(raw);
  }
  function captureResume(socket: WebSocket) {
    socket.once('message', receiveResume);
  }
  wss.once('connection', captureResume);
  const connected = once(wss, 'connection');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const input = { url: `ws://127.0.0.1:${address.port}`, computerId: 'computer',
    assistantId: 'assistant', bearer: 'local-test' };
  const keys = conversationKeys('/unused-approval-test');
  const options = { silo: 'test', store: nats.store, keys };
  const link = await connectBridge(options, input);
  const socketValue = firstEventArgument(await connected);
  if (!(socketValue instanceof WebSocket)) throw new Error('No computer socket');
  const socket = socketValue;
  try {
    const first = await resume.promise;
    if (!Buffer.isBuffer(first)) throw new Error('Expected a resume message');
    const frame: unknown = JSON.parse(first.toString());
    const expectedResume = { type: 'resume', since: 0, approvalWaiting: true };
    expect(frame).toEqual(expectedResume);
    await seedRequest();
    await append(`approval-${approvalId}`, 'approval.cancelled', { approvalId });
    const head = await nats.store.head();
    const { until } = await import('@opencrane/authz/testing');
    function received() { return link.approvals.size === 1; }
    socket.send(JSON.stringify(waiting));
    await until(received);
    const reply = once(socket, 'message');
    await poll(link.approvals);
    const raw = firstEventArgument(await reply);
    if (!Buffer.isBuffer(raw)) throw new Error('Expected a socket message');
    expect(JSON.parse(raw.toString()) as unknown).toEqual({
      type: 'approval_settled', approvalId, state: 'cancelled',
    });
    expect(await nats.store.head()).toBe(head);
    expect(link.rejection).toBeUndefined();
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    link.socket.terminate();
    socket.terminate();
    await link.settled();
    function close(resolve: () => void) { wss.close(resolve); }
    await new Promise<void>(close);
    server.close();
  }
}
it('accepts signals through the socket without storing reports or closing the link',
  acceptsSocketSignals);

function firstEventArgument(value: unknown) {
  if (!Array.isArray(value)) throw new Error('Expected an event argument list');
  const first: unknown = value[0];
  return first;
}

async function* failedRead(): AsyncGenerator<never> {
  yield* [];
  await Promise.resolve();
  throw new Error('Read unavailable');
}

async function refusesMissingRequest() {
  const { approvals, send } = watcher();
  const position = await nats.store.head();
  approvals.receive(waiting);
  await poll(approvals);
  expect(approvals.size).toBe(0);
  const refusal = { type: 'approval_settled', approvalId, state: 'outcome_unknown' };
  expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(refusal));
  expect(await nats.store.head()).toBe(position);
  const read = vi.spyOn(nats.store, 'readStream');
  await poll(approvals);
  expect(read).not.toHaveBeenCalled();
}
it('refuses a missing request once without writing events or retrying', refusesMissingRequest);

async function backsOffRepeatedFailures() {
  const policySequence = await seedLiveTurn();
  const overrides = { policySequence };
  await seedRequest(overrides);
  const { approvals, send } = watcher();
  approvals.receive(waiting);
  const read = vi.spyOn(nats.store, 'readStream');
  read.mockImplementation(failedRead);
  const timers = { toFake: ['Date' as const] };
  vi.useFakeTimers(timers);
  try {
    const startedAt = Date.now();
    await poll(approvals);
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(startedAt + 999);
    await poll(approvals);
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(startedAt + 1000);
    await poll(approvals);
    expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(startedAt + 2999);
    await poll(approvals);
    expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(startedAt + 3000);
    await poll(approvals);
    expect(read).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
}
it('backs off repeated read failures for each entry', backsOffRepeatedFailures);

async function leavesQuietEntriesUnread() {
  const policySequence = await seedLiveTurn();
  const overrides = { policySequence };
  await seedRequest(overrides);
  const { approvals } = watcher();
  approvals.receive(waiting);
  await poll(approvals);
  const head = vi.spyOn(nats.store, 'head');
  await poll(approvals);
  expect(head.mock.calls).toEqual([[]]);
  // Check positions once a new event appears, even if it concerns another stream.
  const member = {
    memberId: 'other', email: 'other@example.test', displayName: 'Other', role: 'member',
  };
  await append('member-other', 'member.joined', member);
  head.mockClear();
  await poll(approvals);
  expect(head).toHaveBeenCalledWith(`approval-${approvalId}`, expect.any(Number));
}
it('checks entry positions only after the overall position moves', leavesQuietEntriesUnread);

async function settlesChangedPolicy() {
  const policySequence = await seedLiveTurn();
  const overrides = { policySequence };
  await seedRequest(overrides);
  const { approvals, send } = watcher();
  approvals.receive(waiting);
  await poll(approvals);
  const unpublished = { serverId: 'fixture', unpublishedBy: 'alice' };
  await append('mcp-fixture', 'mcp.server_unpublished', unpublished);
  await poll(approvals);
  const settlement = { type: 'approval_settled', approvalId, state: 'cancelled' };
  expect(send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(settlement));
  const rows = [];
  for await (const row of nats.store.readStream(`approval-${approvalId}`)) rows.push(row);
  expect(rows.at(-1)?.event.type).toBe('approval.cancelled');
}
it('cancels a held approval promptly after its tool policy changes', settlesChangedPolicy);

const takeover = { assistantId: 'assistant', computerId: 'computer', generation: 1,
  podUid: 'pod', conversationId: 'chat', requesterId: 'alice', requesterEventId: 'turn',
  takeoverId: 'takeover', leaseId: 'takeover', reason: 'requester_requested',
  affectedTurnIds: ['turn', 'second'] };
async function prepareTakeoverApproval() {
  await append('computer-assistant', 'computer.claimed', {
    assistantId: 'assistant', computerId: 'computer', generation: 1, tokenId: 'token:test',
  });
  await seedRequest({ policySequence: await seedLiveTurn() });
}
async function saveTakeover(changes = {}) {
  await append('computer-assistant', 'takeover.requested', { ...takeover, ...changes });
}
async function readCurrent() {
  return readApproval(nats.store, 'test', approvalId);
}
async function cancelsTwoTurns() {
  await prepareTakeoverApproval();
  const secondId = 'b'.repeat(64);
  const original = await readCurrent();
  await append('conversation-second', 'agent.turn_started', {
    conversationId: 'second', turnId: 'second', assistantId: 'assistant',
  });
  await append(`approval-${secondId}`, 'tool.approval_requested', {
    ...original.request, approvalId: secondId, conversationId: 'second', turnId: 'second',
  });
  await append(`approval-${secondId}`, 'approval.decided', {
    approvalId: secondId, decidedBy: 'alice', decision: 'approved',
  });
  await saveTakeover();
  for (const id of [approvalId, secondId]) {
    const current = await readApproval(nats.store, 'test', id);
    expect(current).toMatchObject({ state: 'cancelled', cancelReason: 'takeover' });
    const rows = await history(nats.store, `approval-${id}`, 'test');
    expect(current.endedAt).toBe(rows.at(-1)?.event.time);
    expect(await readApproval(nats.store, 'test', id)).toEqual(current);
    expect(await nats.store.head(`approval-${id}`)).toBe(current.sequence);
  }
}
it('saves one dated cancellation for requested and approved waits on two affected turns',
  cancelsTwoTurns);

async function keepsUnrelated(changes: object) {
  await prepareTakeoverApproval();
  if ('generation' in changes) {
    await append('computer-assistant', 'computer.ready', {
      assistantId: 'assistant', computerId: 'computer', generation: 2, podUid: 'new-pod',
    });
  }
  await saveTakeover(changes);
  const current = await readCurrent();
  expect(current.state).toBe('requested');
  async function fresh() { await Promise.resolve(); }
  const decision = await decideApproval(nats.store, 'test', approvalId, 'alice',
    'approved', true, fresh, current);
  expect(decision.status).toBe('appended');
  expect((await readCurrent()).state).toBe('approved');
}
it.each([{ generation: 2 }, { affectedTurnIds: ['other'] },
  { assistantId: 'other' }, { computerId: 'other' }])(
  'keeps an approval usable when takeover does not match %j', keepsUnrelated);

async function keepsTerminal(type: string, data: object) {
  await prepareTakeoverApproval();
  await append(`approval-${approvalId}`, type, { approvalId, ...data });
  const before = await readCurrent();
  await saveTakeover();
  expect(await readCurrent()).toEqual(before);
}
it.each([
  ['approval.used', { permitId: 'permit' }],
  ['approval.decided', { decidedBy: 'alice', decision: 'rejected' }],
  ['approval.expired', {}], ['approval.cancelled', { cancelReason: 'turn_stopped' }],
])('retains the saved terminal receipt for %s', keepsTerminal);

async function keepsUsedEvidence() {
  const permitId = '00000000-0000-4000-8000-000000000001';
  await prepareTakeoverApproval();
  await append(`approval-${approvalId}`, 'approval.used', { approvalId, permitId });
  const dispatch = { requestId: permitId, approvalId, conversationId: 'chat', turnId: 'turn',
    serverId: 'fixture', toolName: 'write', outcome: 'not_dispatched',
    evidence: 'connection_refused', callId: 'call', logicalRequestId: approvalId,
    startedAt: new Date().toISOString(), durationMs: 0 };
  await append(`decision-${permitId}`, 'tool.dispatch_recorded', dispatch);
  const before = await readCurrent();
  expect(before.canRetry).toBe(true);
  const evidence = await history(nats.store, `decision-${permitId}`, 'test');
  await saveTakeover();
  expect(await readCurrent()).toMatchObject({ state: 'outcome_unknown',
    usedAt: before.usedAt, uses: before.uses, canRetry: false });
  expect(await history(nats.store, `decision-${permitId}`, 'test')).toEqual(evidence);
}
it('keeps used approval evidence and disables an unsent retry during takeover', keepsUsedEvidence);

async function noticesControlOnly() {
  await prepareTakeoverApproval();
  const first = watcher();
  first.approvals.receive(waiting);
  await poll(first.approvals);
  expect(first.send).not.toHaveBeenCalled();
  await saveTakeover();
  await poll(first.approvals);
  await poll(first.approvals);
  const settlement = JSON.stringify({ type: 'approval_settled', approvalId, state: 'cancelled' });
  expect(first.send).toHaveBeenCalledExactlyOnceWith(settlement);
  const second = watcher();
  second.approvals.receive(waiting);
  await poll(second.approvals);
  expect(second.send).toHaveBeenCalledExactlyOnceWith(settlement);
}
it('notices only computer changes and cancels the original wait after reconnect',
  noticesControlOnly);

async function recoversCancellation(lostReply: boolean) {
  await prepareTakeoverApproval();
  await saveTakeover();
  const appendEvent = nats.store.append.bind(nats.store);
  async function failCancellation(command: Parameters<typeof appendEvent>[0]) {
    if (!isCancellation(command.event)) return appendEvent(command);
    if (lostReply) await appendEvent(command);
    return { status: 'unavailable' as const, cause: new Error('Append unavailable') };
  }
  const fault = vi.spyOn(nats.store, 'append').mockImplementation(failCancellation);
  const first = watcher();
  first.approvals.receive(waiting);
  await poll(first.approvals);
  expect(first.send).not.toHaveBeenCalled();
  expect(first.approvals.size).toBe(1);
  fault.mockRestore();
  await waitForDuplicateWindow(nats);
  const connection = await nats.client('command');
  const restarted = await createEventStore(connection);
  const second = readApproval(restarted, 'test', approvalId);
  const third = readCurrent();
  const results = await Promise.all([second, third]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ state: 'cancelled', cancelReason: 'takeover' });
  const rows = await history(nats.store, `approval-${approvalId}`, 'test');
  expect(rows).toHaveLength(2);
  expect(results[0]?.endedAt).toBe(rows[1]?.event.time);
}
it.each([false, true])('recovers one cancellation after append failure (lost reply: %s)',
  recoversCancellation);

async function racesApproval() {
  await prepareTakeoverApproval();
  const current = await readCurrent();
  await saveTakeover();
  let cancelling = false;
  const release = Promise.withResolvers<void>();
  const appendEvent = nats.store.append.bind(nats.store);
  async function holdCancellation(command: Parameters<typeof appendEvent>[0]) {
    if (isCancellation(command.event)) {
      cancelling = true;
      await release.promise;
    }
    return appendEvent(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementation(holdCancellation);
  const reading = readCurrent();
  try {
    function cancellationStarted() { return cancelling; }
    await expect.poll(cancellationStarted).toBe(true);
    async function fresh() { await Promise.resolve(); }
    await decideApproval(nats.store, 'test', approvalId, 'alice', 'approved', true,
      fresh, current);
  } finally {
    release.resolve();
  }
  expect(await reading).toMatchObject({ state: 'cancelled', cancelReason: 'takeover' });
  expect((await readCurrent()).state).toBe('cancelled');
}
it('cannot restore permission when Approve races a cancellation append', racesApproval);

function isCancellation(value: unknown) {
  const parsed = parseEventByType(value);
  return parsed.success && parsed.event.type === 'approval.cancelled';
}
