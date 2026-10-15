import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { computerTokenAudience } from '@opencrane/auth';
import { databases, until } from '@opencrane/authz/testing';
import { envelope } from '@opencrane/models';
import { conversations, pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { fixture as computerFixture } from '../../computer/test/bridge-gate-fixture.ts';
import { requireBridgeGateAuthority } from '../../computer/src/bridge-gate-authority.ts';
import { SandboxClient } from '../../ops/src/kubernetes.ts';
import { connectBridge, watchBridges } from '../src/chat/bridge.ts';
import { readyBridgePass } from '../src/chat/bridge-control.ts';
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
    const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString()));
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
  const options = { store: nats.store, silo: 'test', keys: conversationKeys(dirname(computer.keyPath)) };
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
function frameType(frame: Record<string, unknown>) { return frame['type']; }

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
    const gates = test.frames.filter(isGate);
    expect(gates.length).toBe(1);
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
  const closedValues: unknown = await closed;
  const [code, reason] = z.tuple([z.number(), z.instanceof(Buffer)]).parse(closedValues);
  expect(code).toBe(1008);
  expect(String(reason)).toBe('Invalid bridge receipt');
  expect(link.control.receipt).toBeUndefined();
  expect(await test.store.head('computer-assistant')).toBe(before);
}
async function forgedReceipt(changes: Record<string, unknown>) {
  await refusesReceipt(changes);
}
it.each(invalidReceipts)('refuses a forged receipt %j without saving it', forgedReceipt);
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
  const types = test.frames.map(frameType);
  expect(types).toEqual(['resume']);
}
it.each(['issuer', 'member', 'generation', 'podUid', 'turns', 'unverified'])(
  'sends resume without a gate after %s refusal', skipsGate);

async function watchesIdle(mode: string) {
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
  if (mode === 'connected' || mode === 'suspended') {
    test.keys.provision('test', 'chat');
    const encrypted = test.keys.encrypt('test', 'chat', 'Hello');
    await test.append('conversation-chat', 'message.posted', { conversationId: 'chat',
      authorId: 'alice', authorKind: 'human', contentType: 'text', ...encrypted });
  }
  if (mode !== 'connected') await test.save();
  if (mode === 'unverified') {
    await test.append('computer-assistant', 'takeover.started', {
      assistantId: 'assistant', computerId: 'computer', requestedBy: 'alice' });
  }
  if (mode === 'suspended') {
    await test.append('computer-assistant', 'computer.suspended', {
      computerId: 'computer', assistantId: 'assistant' });
  }
  const work = watchBridges({ ...test, db }, test.computer.issuer, kube, test.url, stop.signal, logger);
  try {
    if (mode === 'suspended' || mode === 'unverified') {
      const before = await test.store.head('computer-assistant');
      await delay(750);
      expect(test.peers).toHaveLength(0);
      expect(await test.store.head('computer-assistant')).toBe(before);
      return;
    }
    if (mode === 'connected') {
      function resumed() { return test.frames.length > 0; }
      await until(resumed, 2000);
      expect(test.frames[0]?.['type']).toBe('resume');
      await test.save();
    }
    function gated() { return test.frames.some(isGate); }
    const start = performance.now();
    await until(gated, 2000);
    expect(performance.now() - start).toBeLessThan(2000);
    if (mode === 'connected') return;
    expect(test.frames[0]?.['type']).toBe('bridge_gate');
    const peer = test.peers[0]!;
    peer.close(mode === 'refused' ? 1008 : 1000, 'Computer refused');
    await delay(750);
    if (mode === 'refused') expect(test.peers).toHaveLength(1);
    else expect(test.peers).toHaveLength(2);
  } finally {
    stop.abort();
    await work;
    await dbs.close();
  }
}
it.each(['idle', 'connected', 'refused', 'suspended', 'unverified'])(
  'polls saved control intent with a %s computer', watchesIdle);

async function legacyReady() {
  const test = await setup();
  const identity = { computerId: 'computer', assistantId: 'assistant' };
  await test.append('computer-assistant', 'computer.ready', identity);
  const before = await test.store.head('computer-assistant');
  const pass = await readyBridgePass(test, identity, test.computer.issuer);
  const claims = await test.computer.issuer.verify(pass.value, computerTokenAudience);
  expect(claims['generation']).toBe(1);
  expect(await test.store.head('computer-assistant')).toBe(before);
}
it('keeps legacy ready connections working without waking or writing', legacyReady);

async function gateDuringSlowChat(connected: boolean) {
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
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readStream = test.store.readStream.bind(test.store);
  async function* holdChat(...args: Parameters<typeof readStream>) {
    if (args[0] === 'conversation-chat') {
      reading.resolve();
      await release.promise;
    }
    yield* readStream(...args);
  }
  if (connected) {
    test.keys.provision('test', 'chat');
    const encrypted = test.keys.encrypt('test', 'chat', 'Hello');
    await test.append('conversation-chat', 'message.posted', { conversationId: 'chat',
      authorId: 'alice', authorKind: 'human', contentType: 'text', ...encrypted });
  } else {
    vi.spyOn(test.store, 'readStream').mockImplementation(holdChat);
  }
  const work = watchBridges({ ...test, db }, test.computer.issuer, kube, test.url, stop.signal, logger);
  let holdUntil = 0;
  try {
    if (connected) {
      function resumed() { return test.frames.some(isResume); }
      await until(resumed, 2000);
      vi.spyOn(test.store, 'readStream').mockImplementation(holdChat);
      await test.append('conversation-chat', 'agent.turn_stop_requested', {
        conversationId: 'chat', turnId: 'first', requestedBy: 'alice' });
    }
    await reading.promise;
    await test.save({ affectedTurnIds: [] });
    const start = performance.now();
    holdUntil = start + 2300;
    function gated() { return test.frames.some(isGate); }
    await until(gated, 2000);
    expect(performance.now() - start).toBeLessThan(2000);
    const gate = test.frames.find(isGate);
    const binding = requireBridgeGateAuthority(gate?.['gate'], test.computer.gateIdentity);
    expect(binding).toEqual({ takeoverId: 'takeover', generation: 1, affectedTurnIds: [] });
    expect(test.frames.filter(isGate)).toHaveLength(1);
  } finally {
    await delay(Math.max(0, holdUntil - performance.now()));
    release.resolve();
    stop.abort();
    await work;
    await dbs.close();
  }
}
it.each([false, true])(
  'sends a verified gate within two seconds while chat is held for 2300 ms, connected: %s',
  gateDuringSlowChat);

function isResume(frame: Record<string, unknown>) { return frame['type'] === 'resume'; }

async function gateDuringReplay(savedBefore: boolean) {
  const test = await setup();
  if (savedBefore) await test.save();
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const subscribe = test.store.subscribe.bind(test.store);
  async function* holdReplay(...args: Parameters<typeof subscribe>) {
    reading.resolve();
    await release.promise;
    yield* subscribe(...args);
  }
  vi.spyOn(test.store, 'subscribe').mockImplementation(holdReplay);
  const connecting = test.connect();
  try {
    await reading.promise;
    if (!savedBefore) await test.save();
    function gated() { return test.frames.some(isGate); }
    await until(gated, 500);
    expect(test.frames.map(frameType)).toEqual(['bridge_gate']);
    const binding = requireBridgeGateAuthority(test.frames[0]?.['gate'], test.computer.gateIdentity);
    expect(binding).toEqual({ takeoverId: 'takeover', generation: 1,
      affectedTurnIds: ['first', 'second'] });
  } finally {
    release.resolve();
    await connecting;
  }
  function resumed() { return test.frames.some(isResume); }
  await until(resumed);
  expect(test.frames.map(frameType)).toEqual(['bridge_gate', 'resume']);
}
it.each([true, false])('sends the gate before report replay finishes, intent saved before: %s',
  gateDuringReplay);

async function gateAfterTurnCloses() {
  const test = await setup();
  await test.save();
  const sign = test.computer.issuer.takeoverGate;
  let changed = false;
  async function closeDuringSigning(...args: Parameters<typeof sign>) {
    const issued = await sign(...args);
    if (!changed) {
      changed = true;
      await test.append('computer-assistant', 'computer.turn_closed', {
        computerId: 'computer', assistantId: 'assistant', conversationId: 'chat',
        turnId: 'first', requesterId: 'alice', task: 'chat_turn', status: 'completed' });
    }
    return issued;
  }
  vi.spyOn(test.computer.issuer, 'takeoverGate').mockImplementation(closeDuringSigning);
  await test.connect();
  function resumed() { return test.frames.some(isResume); }
  await until(resumed, 2000);
  expect(changed).toBe(true);
  expect(test.frames.map(frameType)).toEqual(['bridge_gate', 'resume']);
  const binding = requireBridgeGateAuthority(test.frames[0]?.['gate'], test.computer.gateIdentity);
  expect(binding).toEqual({ takeoverId: 'takeover', generation: 1,
    affectedTurnIds: ['first', 'second'] });
}
it('retries unchanged control after a turn closes during signing, before sending resume',
  gateAfterTurnCloses);

async function gateSigningDuringReplay() {
  const test = await setup();
  const replaying = Promise.withResolvers<void>();
  const replayRelease = Promise.withResolvers<void>();
  const signing = Promise.withResolvers<void>();
  const signRelease = Promise.withResolvers<void>();
  const subscribe = test.store.subscribe.bind(test.store);
  async function* holdReplay(...args: Parameters<typeof subscribe>) {
    replaying.resolve();
    await replayRelease.promise;
    yield* subscribe(...args);
  }
  vi.spyOn(test.store, 'subscribe').mockImplementation(holdReplay);
  const sign = test.computer.issuer.takeoverGate;
  async function holdSigning(...args: Parameters<typeof sign>) {
    signing.resolve();
    await signRelease.promise;
    return sign(...args);
  }
  const signer = vi.spyOn(test.computer.issuer, 'takeoverGate').mockImplementation(holdSigning);
  const connecting = test.connect();
  try {
    await replaying.promise;
    await test.save();
    await signing.promise;
    replayRelease.resolve();
    // Let replay and another timer check finish while signing is still held.
    await delay(350);
    expect(test.frames).toEqual([]);
    expect(signer).toHaveBeenCalledTimes(1);
  } finally {
    replayRelease.resolve();
    signRelease.resolve();
    await connecting;
  }
  function resumed() { return test.frames.some(isResume); }
  await until(resumed, 2000);
  expect(test.frames.map(frameType)).toEqual(['bridge_gate', 'resume']);
  requireBridgeGateAuthority(test.frames[0]?.['gate'], test.computer.gateIdentity);
}
it('waits for one in-flight gate when intent arrives during report replay',
  gateSigningDuringReplay);
