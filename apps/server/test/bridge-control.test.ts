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
import { suspendComputer } from '../../ops/src/lifecycle.ts';

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
  async function close() {
    link.socket.terminate();
    for (const socket of computers.clients) socket.terminate();
    await link.settled();
    computers.close();
    server.close();
    await view.close();
  }
  return { ...options, objects, bytes, message, link, frames, process,
    append: view.append, runner: view.runner, db: view.db,
    intendControl, upload, flushFrames, close };
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
