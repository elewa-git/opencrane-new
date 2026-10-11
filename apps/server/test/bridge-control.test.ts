import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Client } from 'minio/dist/esm/minio.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { fileUploadedDataSchema } from '@opencrane/events';
import { chatHistory } from '../src/chat/commands.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { assistantSnapshot, processConversation, type AgentSession }
  from '../src/chat/bridge-conversation.ts';
import { viewFixture } from './support/view-fixture.ts';

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

async function bridgeFixture() {
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
  async function process() {
    const lifecycle = [];
    for await (const row of options.store.readStream('computer-assistant')) {
      lifecycle.push(row);
    }
    const assistant = assistantSnapshot(lifecycle, 'personal', 'test');
    // Use the already-ready computer; this path never issues a resume token.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- No token is read here.
    const tokens = {} as never;
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
    intendControl, upload, flushFrames, close };
}

async function deliversStopAfterIntent() {
  fixture = await bridgeFixture();
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
it('delivers a saved stop to the bridge after control intent', deliversStopAfterIntent, 30_000);

function isTurnOrFile(frame: Record<string, unknown>) {
  return frame['type'] === 'turn' || String(frame['type']).startsWith('file_');
}

async function holdsUploadsDuringObjectRead() {
  fixture = await bridgeFixture();
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
it('delivers zero file bytes when intent is saved during an object read',
  holdsUploadsDuringObjectRead, 30_000);

function isDelivered(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type === 'file.delivered';
}

async function holdsUploadAfterDeliveryHistoryRead() {
  fixture = await bridgeFixture();
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
it('holds an upload when intent is saved during the sender history read',
  holdsUploadAfterDeliveryHistoryRead, 30_000);

async function holdsRestOfUploadBatch() {
  fixture = await bridgeFixture();
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
it('holds remaining files when intent is saved after the first file acknowledgement',
  holdsRestOfUploadBatch, 30_000);

function isFileBegin(frame: Record<string, unknown>) {
  return frame['type'] === 'file_begin';
}
