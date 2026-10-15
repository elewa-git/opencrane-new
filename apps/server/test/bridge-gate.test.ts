import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases, until } from '@opencrane/authz/testing';
import { envelope } from '@opencrane/models';
import { conversations, pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { fixture as computerFixture } from '../../computer/test/bridge-gate-fixture.ts';
import { requireBridgeGateAuthority } from '../../computer/src/bridge-gate-authority.ts';
import { SandboxClient } from '../../ops/src/kubernetes.ts';
import { connectBridge, watchBridges } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';

let cleanup = async () => {};
afterEach(async function closeFixture() {
  await cleanup();
  vi.restoreAllMocks();
});

async function setup(real = false) {
  const nats = await natsFixture();
  const computer = await computerFixture();
  computer.socket.terminate();
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const frames: Record<string, unknown>[] = [];
  const peers: WebSocket[] = [];
  function receive(bytes: Buffer) {
    const frame: Record<string, unknown> = JSON.parse(bytes.toString());
    frames.push(frame);
  }
  function connected(peer: WebSocket) {
    peers.push(peer);
    peer.on('message', receive);
  }
  sockets.on('connection', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = real ? computer.socket.url : `ws://127.0.0.1:${address.port}`;
  const options = { store: nats.store, silo: 'test', keys: conversationKeys('/unused') };
  const input = { url, computerId: 'computer', assistantId: 'assistant', bearer: 'test' };
  const links: Awaited<ReturnType<typeof connectBridge>>[] = [];
  async function append(subject: string, type: string, data: unknown) {
    await nats.seed([envelope('test', subject, type, data)]);
  }
  cleanup = close;
  const ready = { computerId: 'computer', assistantId: 'assistant', generation: 1, podUid: 'pod' };
  await append('computer-assistant', 'computer.claimed', { computerId: 'computer',
    assistantId: 'assistant', generation: 1, tokenId: 'token:test' });
  await append('computer-assistant', 'computer.ready', ready);
  await append('member-alice', 'member.joined', { memberId: 'alice', role: 'member',
    email: 'alice@example.test', displayName: 'Alice', invitationId: 'invite' });
  const intent = { ...ready, conversationId: 'chat', requesterId: 'alice',
    requesterEventId: 'first', takeoverId: 'takeover', leaseId: 'takeover',
    affectedTurnIds: ['second', 'first'], reason: 'requester_requested' };
  async function save(changes = {}) {
    await append('computer-assistant', 'takeover.requested', { ...intent, ...changes });
  }
  async function connect(withIssuer = true) {
    const issuer = withIssuer ? computer.issuer : undefined;
    const link = await connectBridge(options, input, issuer);
    links.push(link);
    return link;
  }
  async function close() {
    for (const link of links) {
      link.socket.terminate();
      await link.settled();
    }
    for (const peer of peers) peer.terminate();
    sockets.close();
    server.close();
    await computer.close();
    await nats.close();
  }
  cleanup = close;
  return { ...options, computer, frames, peers, ready, append, save, connect, close, url };
}

function quiet(changes = {}) {
  return { type: 'bridge_quiet', takeoverId: 'takeover', generation: 1,
    affectedTurnIds: ['first', 'second'], epoch: 'first-epoch', interruptedTurnIds: ['first'],
    preparingTurnIds: [], runningTurnIds: [], loadedThreadIds: [], heldApprovalIds: [],
    executorProof: 'unavailable', browserProof: 'unavailable', ...changes };
}
function isGate(frame: Record<string, unknown>) { return frame['type'] === 'bridge_gate'; }

async function realReceipt() {
  const test = await setup(true);
  const link = await test.connect();
  await test.save();
  const before = await test.store.head('computer-assistant');
  const start = performance.now();
  await link.control.send();
  function received() { return link.control.receipt !== undefined; }
  await until(received, 2000);
  expect(performance.now() - start).toBeLessThan(2000);
  expect(link.control.receipt).toMatchObject({ type: 'bridge_quiet',
    affectedTurnIds: ['first', 'second'], executorProof: 'unavailable', browserProof: 'unavailable' });
  expect(link.rejection).toBeUndefined();
  expect(await test.store.head('computer-assistant')).toBe(before);
}
it('delivers saved intent on a connected real computer and accepts its quiet receipt', realReceipt);

async function firstOnReconnect() {
  const test = await setup();
  await test.save();
  for (let attempt = 0; attempt < 2; attempt++) {
    test.frames.length = 0;
    const link = await test.connect();
    await test.save();
    await link.control.send();
    function resumed() { return test.frames.length >= 2; }
    await until(resumed);
    expect(test.frames[0]?.['type']).toBe('bridge_gate');
    expect(test.frames[1]?.['type']).toBe('resume');
    expect(test.frames.filter(isGate)).toHaveLength(1);
    const binding = requireBridgeGateAuthority(test.frames[0]?.['gate'], test.computer.gateIdentity);
    expect(binding).toEqual({ takeoverId: 'takeover', generation: 1,
      affectedTurnIds: ['first', 'second'] });
    link.socket.terminate();
  }
}
it('sends one signed gate first on each idle link, before resume, despite repeated intent',
  firstOnReconnect);

const invalidReceipts = [
  { takeoverId: 'foreign' }, { generation: 2 }, { affectedTurnIds: ['second', 'first'] },
  { preparingTurnIds: ['first'] }, { runningTurnIds: ['first'] },
  { loadedThreadIds: ['thread'] }, { heldApprovalIds: ['approval'] },
  { interruptedTurnIds: ['foreign'] }, { executorProof: 'quiet' }, { browserProof: 'quiet' },
  { extra: true }, { epoch: '' },
];
async function refusesReceipt(changes: Record<string, unknown>, previous = false, saved = true) {
  const test = await setup();
  if (saved) await test.save();
  const before = await test.store.head('computer-assistant');
  const link = await test.connect();
  const peer = test.peers[0]!;
  if (previous) {
    peer.send(JSON.stringify(quiet()));
    function received() { return link.control.receipt !== undefined; }
    await until(received);
  }
  const closed = once(peer, 'close');
  peer.send(JSON.stringify(quiet(changes)));
  const [code, reason] = await closed;
  expect(code).toBe(1008);
  expect(String(reason)).toBe('Invalid bridge receipt');
  expect(link.control.receipt).toBeUndefined();
  expect(await test.store.head('computer-assistant')).toBe(before);
}
it.each(invalidReceipts)('refuses a forged receipt %j without saving it', refusesReceipt);
it('refuses a receipt without a gate', async function noGate() {
  await refusesReceipt({}, false, false);
});
it.each(['second-epoch', 'replaced-epoch'])('refuses a changed epoch %s',
  async function changedEpoch(epoch) { await refusesReceipt({ epoch }, true); });

async function unavailable() {
  const test = await setup();
  await test.save();
  const link = await test.connect();
  const receipt = { type: 'bridge_unavailable', takeoverId: 'takeover', generation: 1,
    affectedTurnIds: ['first', 'second'], epoch: 'unavailable-epoch' };
  test.peers[0]!.send(JSON.stringify(receipt));
  function received() { return link.control.receipt !== undefined; }
  await until(received);
  expect(link.control.receipt).toEqual(receipt);
}
it('keeps an unavailable receipt only on its link', unavailable);

async function skipsGate(cause: string) {
  const test = await setup();
  await test.save();
  if (cause === 'member') {
    await test.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
  }
  if (cause === 'generation' || cause === 'podUid') {
    const change = cause === 'generation' ? { generation: 2 } : { podUid: 'replacement' };
    await test.append('computer-assistant', 'computer.ready', { ...test.ready, ...change });
  }
  if (cause === 'turns') {
    const affectedTurnIds: string[] = [];
    for (let index = 0; index < 65; index++) affectedTurnIds.push(`turn-${index}`);
    await test.save({ affectedTurnIds });
  }
  if (cause === 'unverified') {
    await test.append('computer-assistant', 'takeover.started', {
      assistantId: 'assistant', computerId: 'computer', requestedBy: 'alice' });
  }
  const link = await test.connect(cause !== 'issuer');
  await link.control.send();
  function resumed() { return test.frames.length > 0; }
  await until(resumed);
  expect(test.frames).toEqual([{ type: 'resume', since: 0, approvalWaiting: true }]);
}
it.each(['issuer', 'member', 'generation', 'podUid', 'turns', 'unverified'])(
  'sends resume without a gate after %s refusal', skipsGate);

async function watchesIdle(refusing: boolean) {
  const test = await setup();
  const dbs = await databases();
  const db = pgDb(dbs.queue);
  const logger = createLogger('gate-test', { level: 'silent' });
  const runner = new ProjectionRunner(db, test.store, logger);
  await test.append('assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal' });
  await test.append('conversation-chat', 'conversation.created', {
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' });
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('http://unused', 'test', 'http://unused', 'http://unused');
  vi.spyOn(kube, 'credentials').mockResolvedValue(undefined);
  const stop = new AbortController();
  await test.save();
  const work = watchBridges({ ...test, db }, test.computer.issuer, kube, test.url, stop.signal, logger);
  try {
    function gated() { return test.frames.some(isGate); }
    await until(gated, 2000);
    expect(test.frames[0]?.['type']).toBe('bridge_gate');
    const peer = test.peers[0]!;
    peer.close(refusing ? 1008 : 1000, 'Computer refused');
    await delay(750);
    if (refusing) expect(test.peers).toHaveLength(1);
    else expect(test.peers).toHaveLength(2);
  } finally {
    stop.abort();
    await work;
    await dbs.close();
  }
}
it.each([false, true])('opens an idle computer and reconnects only if not refused: %s', watchesIdle);
