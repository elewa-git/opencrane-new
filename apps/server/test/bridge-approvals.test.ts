import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
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
  nats = await natsFixture();
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
  await append('mcp-fixture', 'mcp.server_discovered', {
    serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    schemaDigest: approvalId, toolCount: 0,
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
  approvals.poll();
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
async function checksChangedConversation() {
  await seedRequest({ policySequence: await seedLiveTurn() });
  const { approvals, send } = watcher();
  approvals.receive(waiting);
  await poll(approvals);
  expect(send).not.toHaveBeenCalled();
  const read = vi.spyOn(nats.store, 'readStream');
  await poll(approvals);
  expect(read).not.toHaveBeenCalled();
  await append('conversation-chat', 'agent.turn_stop_requested', {
    conversationId: 'chat', turnId: 'turn', requestedBy: 'alice',
  });
  await poll(approvals);
  expect(send).toHaveBeenCalledWith(JSON.stringify({
    type: 'approval_settled', approvalId, state: 'cancelled',
  }));
}
it('reads only changed streams and cancels when the conversation closes',
  checksChangedConversation);

async function retriesFailedRead() {
  await seedRequest({ policySequence: await seedLiveTurn() });
  const { approvals, send } = watcher();
  approvals.receive(waiting);
  await poll(approvals);
  await append(`approval-${approvalId}`, 'approval.decided', {
    approvalId, decidedBy: 'alice', decision: 'rejected',
  });
  const head = vi.spyOn(nats.store, 'head');
  head.mockRejectedValueOnce(new Error('Read unavailable'));
  await poll(approvals);
  expect(send).not.toHaveBeenCalled();
  await poll(approvals);
  expect(send).toHaveBeenCalledTimes(1);
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
  approvals.poll();
  approvals.receive({ ...waiting, approvalId: blocked });
  approvals.poll();
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
  expect(send).not.toHaveBeenCalled();
}
it('bounds waiting entries, refuses unknown fields and forgets a closed link',
  boundsWaitingEntries);

async function acceptsSocketSignals() {
  const { connectBridge } = await import('../src/chat/bridge.ts');
  const { conversationKeys } = await import('../src/chat/keys.ts');
  const server = createServer();
  const wss = new WebSocketServer({ server });
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
