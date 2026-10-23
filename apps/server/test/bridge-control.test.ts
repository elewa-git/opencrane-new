import { setTimeout as delay } from 'node:timers/promises';
import { takeoverClock, waitForControl } from './support/takeover-clock.ts';
import { createEventStore } from '@opencrane/event-store';
import { savePausing } from '../src/chat/bridge-pausing.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { readComputerControl } from '@opencrane/auth';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Client } from 'minio/dist/esm/minio.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { fileUploadedDataSchema } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { assistantProcessor } from '../src/chat/bridge-poll.ts';
import { chatHistory } from '../src/chat/commands.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { assistantSnapshot, processConversation, type AgentSession }
  from '../src/chat/bridge-conversation.ts';
import { listOpenConversations } from '@opencrane/projections';
import { viewFixture } from './support/view-fixture.ts';
import { suspendComputer } from '../../ops/test/server.ts';

type Fixture = Awaited<ReturnType<typeof bridgeFixture>>;
let fixture: Fixture | undefined;

function noDesktop(): Promise<never> {
  return Promise.reject(new Error('No viewer is needed'));
}

async function cleanup() {
  vi.restoreAllMocks();
  await fixture?.close();
  fixture = undefined;
}
afterEach(cleanup);

async function bridgeFixture(cachedControl = false) {
  const view = await viewFixture(noDesktop);
  view.keys.provision('test', 'chat');
  const encrypted = view.keys.encrypt('test', 'chat', 'Keep working');
  const message = await view.append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...encrypted,
  });
  const server = createServer();
  const computers = new WebSocketServer({ server });
  const frames: Record<string, unknown>[] = [];
  let uploading: z.infer<typeof fileUploadedDataSchema> | undefined;
  function connected(socket: WebSocket) {
    function receive(bytes: Buffer) {
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(bytes.toString()));
      frames.push(frame);
      if (frame['type'] === 'file_begin') {
        const { type: _type, ...file } = frame;
        uploading = fileUploadedDataSchema.parse(file);
      }
      if (frame['type'] === 'file_end' && uploading) {
        const receipt = {
          type: 'file_received', fileId: uploading.fileId, sha256: uploading.sha256,
        };
        socket.send(JSON.stringify(receipt));
      }
    }
    socket.on('message', receive);
  }
  computers.on('connection', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bridge port');
  const options = { ...view, store: view.nats.store, silo: 'test' };
  const bridge = {
    url: `ws://127.0.0.1:${address.port}`, computerId: 'desktop',
    assistantId: 'assistant', bearer: 'test-token',
  };
  const link = { ...await connectBridge(options, bridge), connectionId: 1 };
  const conversation: AgentSession = {
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice',
    mode: 'agent_session', createdAt: message.time, assistantKind: 'personal',
  };
  const objects = new Client({ endPoint: '127.0.0.1', useSSL: false });
  function connection() {
    return Promise.resolve(link);
  }
  function connectionId() {
    return link.connectionId;
  }
  // Use the already-ready computer; neither path issues a resume token.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- No token is read here.
  const tokens = {} as never;
  const watchOptions = { ...options, objects };
  const logger = createLogger('bridge-control-test');
  const processor = assistantProcessor(watchOptions, tokens, new Set(),
    connection, connectionId, logger);
  async function process() {
    if (cachedControl) return processor.processAssistant([conversation]);
    const lifecycle = [];
    for await (const row of options.store.readStream('computer-assistant')) {
      lifecycle.push(row);
    }
    const assistant = assistantSnapshot(lifecycle, 'personal', 'test');
    return processConversation({ ...options, objects }, tokens, conversation,
      assistant, new Set(), connection);
  }
  async function pollStops() {
    processor.pollStops([conversation]);
    await processor.settledStops();
  }
  async function intendControl() {
    return view.append('computer-assistant', 'takeover.requested', {
      assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: 'fixture',
      conversationId: 'chat', requesterId: 'alice', requesterEventId: message.id,
      takeoverId: 'control', leaseId: 'control', reason: 'requester_requested',
      affectedTurnIds: [message.id],
    });
  }
  const bytes = Buffer.from('file contents');
  async function upload(fileId: string) {
    const hash = createHash('sha256');
    const sha256 = hash.update(bytes).digest('hex');
    return view.append('conversation-chat', 'file.uploaded', {
      conversationId: 'chat', fileId, uploadedBy: 'alice', name: `${fileId}.txt`,
      size: bytes.length, sha256, mime: 'text/plain', objectKey: `test/chat/${fileId}`,
    });
  }
  async function flushFrames() {
    const pong = once(link.socket, 'pong');
    link.socket.ping();
    await pong;
  }
  const watchers: (() => Promise<void>)[] = [];
  function startControls(connect = connection, store = options.store) {
    const watchedOptions = { ...watchOptions, store };
    const refused = new Set<string>();
    const watcher = assistantProcessor(watchedOptions, tokens, refused,
      connect, connectionId, logger);
    watcher.forgetMissing([conversation]);
    const abort = new AbortController();
    const watching = watcher.watchControls(abort.signal);
    async function stop() {
      abort.abort();
      await watching;
    }
    watchers.push(stop);
    return Object.assign(stop, { forgetMissing: watcher.forgetMissing });
  }
  async function close() {
    for (const stop of watchers) await stop();
    link.socket.terminate();
    for (const socket of computers.clients) socket.terminate();
    await link.settled();
    computers.close();
    server.close();
    await view.close();
  }
  return { ...options, objects, bytes, message, link, frames, process, pollStops, logger,
    append: view.append, runner: view.runner, db: view.db,
    intendControl, upload, flushFrames, startControls, close };
}

it('fails each queued input once after close and keeps the original messages', async () => {
  fixture = await bridgeFixture();
  const test = fixture;
  const second = await test.append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text',
    ...test.keys.encrypt('test', 'chat', 'Another request'),
  });
  await test.append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'routine', authorKind: 'system', contentType: 'text',
    ...test.keys.encrypt('test', 'chat', 'Routine update'),
  });
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });

  await test.process();
  await test.process();
  await test.flushFrames();

  const rows = await chatHistory(test.store, 'test', 'chat');
  const failures = rows.filter(isClosedFailure);
  expect(failures.map(turnIdOf)).toEqual([test.message.id, second.id]);
  expect(rows.filter(isPosted)).toHaveLength(3);
  expect(test.frames.filter(isTurnOrFile)).toEqual([]);
});

it('keeps a closed agent session in the watcher list after projection catches up', async () => {
  fixture = await bridgeFixture();
  const test = fixture;
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });
  await test.runner.run((await import('@opencrane/projections')).conversations);

  const candidates = await listOpenConversations(test.db, 'test');
  expect(candidates.map(candidateId)).toContain('chat');
});

async function startFixtureTurn(test: Fixture) {
  const turn = {
    conversationId: 'chat', assistantId: 'assistant', turnId: test.message.id,
    threadId: 'thread',
  };
  await test.append('conversation-chat', 'agent.turn_started', turn);
  await test.append('computer-assistant', 'computer.turn_started', {
    ...turn, requesterId: 'alice', computerId: 'desktop', task: 'chat_turn',
    payingGroupId: 'personal',
  });
  return turn;
}

it('recovers a missing computer close once after an agent terminal and restart', async () => {
  fixture = await bridgeFixture();
  const test = fixture;
  const turn = await startFixtureTurn(test);
  await test.append('conversation-chat', 'agent.turn_failed', {
    conversationId: 'chat', turnId: turn.turnId, reason: 'bridge_interrupted',
  });
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });

  await test.process();
  await test.process();

  const rows = [];
  for await (const row of test.store.readStream('computer-assistant')) rows.push(row);
  expect(rows.filter(isComputerTurnClosed)).toHaveLength(1);
  expect(test.frames.filter(isTurnOrFile)).toEqual([]);
});

it('recovers a missing agent terminal from a saved computer close once', async () => {
  fixture = await bridgeFixture();
  const test = fixture;
  const turn = await startFixtureTurn(test);
  await test.append('computer-assistant', 'computer.turn_closed', {
    ...turn, requesterId: 'alice', computerId: 'desktop', task: 'chat_turn',
    payingGroupId: 'personal', status: 'completed',
  });
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });

  await test.process();
  await test.process();

  const rows = await chatHistory(test.store, 'test', 'chat');
  expect(rows.filter(isAgentCompleted).map(turnIdOf)).toEqual([turn.turnId]);
  expect(test.frames.filter(isStop)).toEqual([]);
});

it('retries a closed turn Stop without sending its input again', async () => {
  fixture = await bridgeFixture();
  const test = fixture;
  const turn = await startFixtureTurn(test);
  await test.append('computer-assistant', 'computer.turn_started', {
    conversationId: 'other', assistantId: 'assistant', turnId: 'other-input',
    threadId: 'bob-thread', requesterId: 'bob', computerId: 'desktop',
    task: 'chat_turn', payingGroupId: 'personal',
  });
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });

  await test.process();
  test.link.sentStops.set(`close:${turn.turnId}`, -Infinity);
  await test.process();
  await test.flushFrames();

  const stops = test.frames.filter(isStop);
  expect(stops).toEqual([expect.objectContaining({ turnId: turn.turnId }),
    expect.objectContaining({ turnId: turn.turnId })]);
  expect(stops.every(isChatStop)).toBe(true);
  expect(test.frames.filter(isTurnOrFile)).toEqual([]);
});

it('stops a running turn after a legacy close changes only participation history', async () => {
  fixture = await bridgeFixture(true);
  const test = fixture;
  const turn = await startFixtureTurn(test);

  await test.process();
  await test.append('participation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });

  await test.process();
  await test.flushFrames();
  expect(test.frames.filter(isStop)).toEqual([
    expect.objectContaining({ turnId: turn.turnId, conversationId: 'chat' }),
  ]);
});

it('does not reread an unchanged legacy closed chat during Stop polling', async () => {
  fixture = await bridgeFixture(true);
  const test = fixture;
  await test.append('conversation-chat', 'agent.turn_failed', {
    conversationId: 'chat', turnId: test.message.id, reason: 'bridge_interrupted',
  });
  await test.append('participation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });
  await test.process();

  const reads = vi.spyOn(test.store, 'readStream');
  await test.pollStops();
  function isChatRead(call: typeof reads.mock.calls[number]) {
    return call[0] === 'conversation-chat' || call[0] === 'participation-chat';
  }
  expect(reads.mock.calls.filter(isChatRead)).toEqual([]);
});

it('keeps the computer ready until the closed chat turn has a computer ending', async () => {
  fixture = await bridgeFixture();
  const test = fixture;
  const turn = await startFixtureTurn(test);
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });
  await test.append('conversation-chat', 'agent.turn_failed', {
    conversationId: 'chat', turnId: turn.turnId, reason: 'bridge_interrupted',
  });
  const computerRows = [];
  for await (const row of test.store.readStream('computer-assistant')) computerRows.push(row);
  const ready = computerRows.find(isComputerReady)?.event;
  if (!ready) throw new Error('Ready computer fixture missing');
  const state = { assistantId: 'assistant', computerId: 'desktop', latest: ready, ready };

  expect((await suspendComputer(test.store, state)).type).toBe('computer.ready');
  await test.process();
  expect((await suspendComputer(test.store, state)).type).toBe('computer.suspended');
});

it('keeps a late admitted start pending after a queued cancellation', async () => {
  fixture = await bridgeFixture(true);
  const test = fixture;
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });
  await test.process();
  const turn = {
    conversationId: 'chat', assistantId: 'assistant', turnId: test.message.id,
    threadId: 'thread', requesterId: 'alice', computerId: 'desktop',
    task: 'chat_turn', payingGroupId: 'personal',
  };
  await test.append('computer-assistant', 'computer.turn_started', turn);

  expect(await test.process()).toBe(true);
  await test.flushFrames();
  expect(test.frames.filter(isStop)).toHaveLength(1);
  expect(test.frames.filter(isTurnOrFile)).toEqual([]);
  const rows = await chatHistory(test.store, 'test', 'chat');
  expect(rows.filter(isClosedFailure)).toHaveLength(1);
});

it('settles a lost generation without opening another computer connection', async () => {
  fixture = await bridgeFixture();
  const test = fixture;
  const turn = await startFixtureTurn(test);
  await test.append('computer-assistant', 'computer.lost', {
    assistantId: 'assistant', computerId: 'desktop',
  });
  await test.append('conversation-chat', 'conversation.closed', {
    conversationId: 'chat', closedBy: 'alice',
  });

  await test.process();
  await test.process();
  const rows = await chatHistory(test.store, 'test', 'chat');
  expect(rows.filter(isClosedFailure).map(turnIdOf)).toEqual([turn.turnId]);
  const computerRows = [];
  for await (const row of test.store.readStream('computer-assistant')) computerRows.push(row);
  expect(computerRows.filter(isComputerTurnClosed)).toHaveLength(1);
  expect(test.frames.filter(isStop)).toEqual([]);
});

function isComputerTurnClosed(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'computer.turn_closed';
}

function isAgentCompleted(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'agent.turn_completed';
}

function isStop(frame: Record<string, unknown>) {
  return frame['type'] === 'stop';
}

function isChatStop(frame: Record<string, unknown>) {
  return frame['conversationId'] === 'chat';
}

function isComputerReady(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'computer.ready';
}

function isClosedFailure(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'agent.turn_failed' &&
    z.object({ reason: z.string() }).parse(row.event.data).reason === 'conversation_closed';
}

function turnIdOf(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return z.object({ turnId: z.string() }).parse(row.event.data).turnId;
}

function isPosted(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'message.posted';
}

function candidateId(row: { conversationId: string }) {
  return row.conversationId;
}

async function deliversStopAfterIntent(cachedControl: boolean) {
  fixture = await bridgeFixture(cachedControl);
  const turn = {
    conversationId: 'chat', assistantId: 'assistant', turnId: fixture.message.id,
    threadId: 'thread',
  };
  await fixture.append('conversation-chat', 'agent.turn_started', turn);
  await fixture.append('computer-assistant', 'computer.turn_started', {
    ...turn, requesterId: 'alice', computerId: 'desktop',
    task: 'chat_turn', payingGroupId: 'personal',
  });
  await fixture.intendControl();
  await fixture.append('conversation-chat', 'agent.turn_stop_requested', {
    conversationId: 'chat', turnId: fixture.message.id, requestedBy: 'alice',
  });

  await fixture.process();
  await fixture.flushFrames();

  expect(fixture.frames).toContainEqual({
    type: 'stop', turnId: fixture.message.id, conversationId: 'chat',
  });
  expect(fixture.frames.filter(isTurnOrFile)).toEqual([]);
}
it.each([false, true])('delivers a saved stop after control intent with cached control: %s',
  deliversStopAfterIntent, 30_000);

function isTurnOrFile(frame: Record<string, unknown>) {
  return frame['type'] === 'turn' || String(frame['type']).startsWith('file_');
}

async function holdsUploadsDuringObjectRead(cachedControl: boolean) {
  fixture = await bridgeFixture(cachedControl);
  const test = fixture;
  await test.upload('first');
  await test.upload('second');
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function readObject() {
    reading.resolve();
    await release.promise;
    return Readable.from([test.bytes]);
  }
  const objectReads = vi.spyOn(test.objects, 'getObject').mockImplementation(readObject);
  const processing = test.process();
  try {
    await reading.promise;
    await test.intendControl();
  } finally {
    release.resolve();
    await processing;
  }
  await test.flushFrames();

  expect(test.frames.filter(isTurnOrFile)).toEqual([]);
  expect(objectReads).toHaveBeenCalledTimes(1);
  const rows = await chatHistory(test.store, 'test', 'chat');
  expect(rows.some(isDelivered)).toBe(false);
}
it.each([false, true])('holds files when intent arrives during object reads with cached control: %s',
  holdsUploadsDuringObjectRead, 30_000);

function isDelivered(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'file.delivered';
}

async function holdsUploadAfterDeliveryHistoryRead(cachedControl: boolean) {
  fixture = await bridgeFixture(cachedControl);
  const test = fixture;
  await test.upload('first');
  function readObject() {
    return Promise.resolve(Readable.from([test.bytes]));
  }
  vi.spyOn(test.objects, 'getObject').mockImplementation(readObject);
  const readStream = test.store.readStream.bind(test.store);
  let changed = false;
  async function* readBeforeIntent(...args: Parameters<typeof readStream>) {
    yield* readStream(...args);
    // Save intent after the sender's history read, before it can transmit a file.
    if (args[0] === 'conversation-chat' && !changed) {
      changed = true;
      await test.intendControl();
    }
  }
  async function deliverAfterIntent(...args: Parameters<typeof test.link.deliver>) {
    const reading = vi.spyOn(test.store, 'readStream').mockImplementation(readBeforeIntent);
    try {
      await deliver(...args);
    } finally {
      reading.mockRestore();
    }
  }
  const deliver = test.link.deliver;
  test.link.deliver = deliverAfterIntent;

  await test.process();
  await test.flushFrames();

  expect(changed).toBe(true);
  expect(test.frames.filter(isTurnOrFile)).toEqual([]);
  const rows = await chatHistory(test.store, 'test', 'chat');
  expect(rows.some(isDelivered)).toBe(false);
}
it.each([false, true])('holds files after delivery history reads with cached control: %s',
  holdsUploadAfterDeliveryHistoryRead, 30_000);

async function holdsRestOfUploadBatch(cachedControl: boolean) {
  fixture = await bridgeFixture(cachedControl);
  const test = fixture;
  await test.upload('first');
  await test.upload('second');
  function readObject() {
    return Promise.resolve(Readable.from([test.bytes]));
  }
  const objectReads = vi.spyOn(test.objects, 'getObject').mockImplementation(readObject);
  const deliver = test.link.deliver;
  let changed = false;
  async function deliverBeforeIntent(...args: Parameters<typeof deliver>) {
    await deliver(...args);
    if (!changed) {
      changed = true;
      await test.intendControl();
    }
  }
  test.link.deliver = deliverBeforeIntent;

  await test.process();
  await test.flushFrames();

  expect(changed).toBe(true);
  expect(objectReads).toHaveBeenCalledTimes(1);
  const delivered = test.frames.filter(isFileBegin);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.['fileId']).toBe('first');
  const rows = await chatHistory(test.store, 'test', 'chat');
  const receipts = rows.filter(isDelivered);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.event.data).toMatchObject({ fileId: 'first' });
}
it.each([false, true])('holds the remaining upload batch with cached control: %s',
  holdsRestOfUploadBatch, 30_000);

function isFileBegin(frame: Record<string, unknown>) {
  return frame['type'] === 'file_begin';
}

async function holdsTurnAfterSnapshot(subject: string) {
  fixture = await bridgeFixture(true);
  const test = fixture;
  const readStream = test.store.readStream.bind(test.store);
  let changed = false;
  async function* readBeforeIntent(...args: Parameters<typeof readStream>) {
    yield* readStream(...args);
    // Save intent during preparation, after the watcher has cached the ready computer.
    if (args[0] === subject && !changed) {
      changed = true;
      await test.intendControl();
    }
  }
  vi.spyOn(test.store, 'readStream').mockImplementation(readBeforeIntent);

  await test.process();
  await test.flushFrames();

  expect(changed).toBe(true);
  expect(test.frames.filter(isTurnOrFile)).toEqual([]);
}
it.each(['conversation-chat', 'member-alice'])(
  'holds a new turn when intent arrives after the cached snapshot during %s reads',
  holdsTurnAfterSnapshot, 30_000);

async function holdsSavedOutcome(phase: 'paused' | 'failed') {
  fixture = await bridgeFixture(true);
  const binding = { assistantId: 'assistant', computerId: 'desktop', generation: 1,
    podUid: 'fixture', takeoverId: 'control', affectedTurnIds: [] };
  let data: unknown = { ...binding, reason: 'pause_timeout' };
  if (phase === 'paused') {
    data = { ...binding, bridgeEpoch: 'bridge', supervisorEpoch: 'supervisor',
      quietProof: 'complete' };
  }
  // Check the outcome itself: a preceding request must not hide a missing type check.
  await fixture.append('computer-assistant', `takeover.${phase}`, data);
  await fixture.process();
  await fixture.flushFrames();
  expect(fixture.frames.filter(isTurnOrFile)).toEqual([]);
}
it.each(['paused', 'failed'] as const)('holds a new chat turn after saved %s', holdsSavedOutcome);

it('sends a manual Stop without waiting for ordinary conversation delivery', async () => {
  fixture = await bridgeFixture(true);
  const test = fixture;
  const turn = await startFixtureTurn(test);
  await test.append('conversation-chat', 'agent.turn_stop_requested', {
    conversationId: 'chat', turnId: turn.turnId, requestedBy: 'alice',
  });
  await test.pollStops();
  await test.flushFrames();
  expect(test.frames.filter(isStop)).toEqual([
    expect.objectContaining({ turnId: turn.turnId, conversationId: 'chat' }),
  ]);
});
async function expiresWithoutReadyComputer() {
  fixture = await bridgeFixture();
  const test = fixture;
  const request = await test.intendControl();
  await test.append('computer-assistant', 'computer.lost', {
    assistantId: 'assistant', computerId: 'desktop',
  });
  const expired = Date.parse(request.time) + 30_000;
  vi.spyOn(Date, 'now').mockReturnValue(expired);
  test.startControls();
  await waitForControl(test.store, 'failed');
}
it('fails an old request immediately on restart without a ready computer',
  expiresWithoutReadyComputer);

async function deadlineWithoutConnection(phase: 'requested' | 'pausing', held: boolean) {
  fixture = await bridgeFixture();
  const test = fixture;
  const request = await test.intendControl();
  const clock = takeoverClock(request.time);
  if (phase === 'pausing') {
    const control = await readComputerControl(test.store, 'test', 'assistant');
    if (!control || control.phase !== 'requested') throw new Error('Missing request');
    const receipt = { kind: 'executor_stop', generation: 1, podUid: 'fixture',
      takeoverId: 'control', affectedTurnIds: [test.message.id], epoch: 'supervisor',
      executionQuiet: true, executionInventory: [], desktopInventory: [],
      quietProof: 'complete', controlEnabled: false };
    await savePausing(test.store, 'test', control, control.position, 'bridge', receipt);
  }
  // Establish the first observation before moving either clock.
  await test.link.control.send();
  const connecting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function unavailable(): Promise<never> {
    connecting.resolve();
    if (held) await release.promise;
    throw new Error('Bridge unavailable');
  }
  test.startControls(unavailable);
  try {
    await connecting.promise;
    clock.advance(29_999, -60_000);
    await delay(300);
    expect((await readComputerControl(test.store, 'test', 'assistant'))?.phase).toBe(phase);
    clock.advance(30_000, -60_000);
    await waitForControl(test.store, 'failed');
    await test.process();
    expect(test.frames.filter(isTurnOrFile)).toEqual([]);
  } finally {
    release.resolve();
  }
}
it.each([['requested', false], ['requested', true], ['pausing', false], ['pausing', true]] as const)(
  'expires %s at thirty seconds with backwards time and held connection: %s',
  deadlineWithoutConnection);

async function retriesOriginalFailure(lostReply: boolean) {
  fixture = await bridgeFixture();
  const test = fixture;
  const request = await test.intendControl();
  const clock = takeoverClock(request.time);
  const info = await test.nats.connection.request('$JS.API.STREAM.INFO.EVENTS');
  const streamInfo = z.object({ config: z.record(z.string(), z.unknown()) });
  const details = streamInfo.parse(info.json());
  const config = details.config;
  const updated = { ...config, duplicate_window: 100_000_000 };
  const response = await test.nats.connection.request('$JS.API.STREAM.UPDATE.EVENTS',
    new TextEncoder().encode(JSON.stringify(updated)));
  expect(z.object({ error: z.unknown().optional() }).parse(response.json()).error).toBeUndefined();
  const append = test.store.append.bind(test.store);
  const attempted = Promise.withResolvers<void>();
  const ids = new Set<string>();
  let unavailable = true;
  async function interrupted(command: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string(), id: z.string() }).parse(command.event);
    if (event.type === 'takeover.failed') {
      ids.add(event.id);
      attempted.resolve();
      if (unavailable) {
        if (lostReply) await append(command);
        throw new Error('Event store unavailable');
      }
    }
    return append(command);
  }
  vi.spyOn(test.store, 'append').mockImplementation(interrupted);
  clock.advance(30_000);
  const stop = test.startControls();
  await attempted.promise;
  const context = { silo: 'test', assistantId: 'assistant', computerId: 'desktop' };
  const start = { conversationId: 'chat', turnId: test.message.id,
    threadId: 'thread', status: 'started' as const };
  await expect(turnCommand(test.store, context, start)).rejects.toThrow('Computer control');
  await stop();
  unavailable = false;
  await delay(150);
  clock.advance(180_000);
  const restarted = await createEventStore(test.nats.connection);
  test.startControls(undefined, restarted);
  await waitForControl(test.store, 'failed');
  await delay(300);
  const failures = [];
  for await (const row of test.store.readStream('computer-assistant')) {
    if (row.event.type === 'takeover.failed') failures.push(row.event);
  }
  expect(failures).toHaveLength(1);
  expect(ids.size).toBe(1);
  expect(failures[0]?.id).toBe([...ids][0]);
}
it.each([false, true])('restarts the original failure after append outage; lost reply: %s',
  retriesOriginalFailure);

async function secondServerKeepsDeadline() {
  fixture = await bridgeFixture();
  const test = fixture;
  const request = await test.intendControl();
  const clock = takeoverClock(request.time);
  await test.link.control.send();
  const connected = Promise.withResolvers<void>();
  function unavailable(): Promise<never> {
    connected.resolve();
    const error = new Error('Bridge unavailable');
    return Promise.reject(error);
  }
  const first = test.startControls(unavailable);
  await connected.promise;
  clock.advance(10_000);
  const secondStore = await createEventStore(test.nats.connection);
  const secondOptions = { ...test, store: secondStore };
  const input = { url: test.link.socket.url, computerId: 'desktop',
    assistantId: 'assistant', bearer: 'test-token' };
  const secondLink = await connectBridge(secondOptions, input);
  try {
    test.startControls(unavailable, secondStore);
    await first();
    clock.advance(30_000, -60_000);
    await waitForControl(secondStore, 'failed');
    const position = await secondStore.head('computer-assistant');
    await test.link.control.send();
    await delay(300);
    expect(await secondStore.head('computer-assistant')).toBe(position);
  } finally {
    secondLink.socket.terminate();
    await secondLink.settled();
  }
}
it('keeps the saved deadline on another server after repeated polls and clock rollback',
  secondServerKeepsDeadline);

async function stopsDeadlineOnShutdown() {
  fixture = await bridgeFixture();
  const test = fixture;
  const request = await test.intendControl();
  const clock = takeoverClock(request.time);
  await test.link.control.send();
  const stop = test.startControls();
  await stop();
  clock.advance(60_000);
  await delay(300);
  expect((await readComputerControl(test.store, 'test', 'assistant'))?.phase).toBe('requested');
  const restarted = await createEventStore(test.nats.connection);
  test.startControls(undefined, restarted);
  await waitForControl(restarted, 'failed');
}
it('stops deadline work on shutdown and fails the old request on restart',
  stopsDeadlineOnShutdown);

async function retiresForgottenDeadline(pending: boolean) {
  fixture = await bridgeFixture();
  const test = fixture;
  let clock: ReturnType<typeof takeoverClock> | undefined;
  if (pending) {
    const request = await test.intendControl();
    clock = takeoverClock(request.time);
    await test.link.control.send();
  }
  const stop = test.startControls();
  await delay(300);
  stop.forgetMissing([]);
  if (clock) {
    clock.advance(30_000, -60_000);
    await waitForControl(test.store, 'failed');
  }
  await delay(300);
  const reads = vi.spyOn(test.store, 'head');
  await delay(600);
  await stop();
  expect(reads).not.toHaveBeenCalled();
}
it.each([false, true])(
  'retires forgotten deadline polling after any pending request finishes: %s',
  retiresForgottenDeadline);

async function logsFailureOutageOnce() {
  fixture = await bridgeFixture();
  const test = fixture;
  const request = await test.intendControl();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(request.time) + 30_000);
  const warning = vi.spyOn(test.logger, 'warn');
  const append = test.store.append.bind(test.store);
  const repeated = Promise.withResolvers<void>();
  let attempts = 0;
  let unavailable = true;
  async function fail(command: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'takeover.failed' && unavailable) {
      attempts++;
      if (attempts === 3) repeated.resolve();
      throw new Error('Private upstream credential and request details');
    }
    return append(command);
  }
  vi.spyOn(test.store, 'append').mockImplementation(fail);
  test.startControls();
  await repeated.promise;
  expect(warning.mock.calls).toEqual([
    ['Takeover deadline check unavailable; work remains blocked'],
  ]);
  unavailable = false;
  await waitForControl(test.store, 'failed');
}
it('logs a fixed warning once while saving a timeout keeps failing', logsFailureOutageOnce);
