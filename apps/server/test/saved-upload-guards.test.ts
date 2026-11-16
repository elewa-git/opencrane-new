import { history } from '@opencrane/models';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { chatHistory } from '../src/chat/commands.ts';
import { assistantSnapshot, processConversation, turnMessage }
  from '../src/chat/bridge-conversation.ts';
import type { ExecutionMode } from '../src/chat/turns.ts';
import { saveInput, saveSession, saveUpload, savedSessionFixture }
  from './support/saved-session.ts';

let fixture: Awaited<ReturnType<typeof savedSessionFixture>>;
async function initialise() {
  fixture = await savedSessionFixture();
}
async function close() {
  await fixture?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
afterEach(vi.restoreAllMocks);

async function excludesRestrictedAttachments() {
  const conversationId = 'restricted-attachments';
  const conversation = await saveSession(fixture, { conversationId, mode: 'restricted' });
  const upload = await saveUpload(fixture, conversationId);
  const message = await saveInput(fixture, conversationId, 'restricted');
  const rows = await chatHistory(fixture.nats.store, 'test', conversationId);
  const posted = rows.find(isMessage)!;
  function isMessage(row: typeof rows[number]) {
    return row.event.id === message.id;
  }
  const uploads = [upload.file];
  const unrestricted = turnMessage(fixture.options, conversation, rows, uploads, posted,
    'memory_free');
  expect(unrestricted.attachments).toEqual([
    { fileId: upload.file.fileId, name: 'notes.txt', mime: 'text/plain' },
  ]);
  const restricted = turnMessage(fixture.options, conversation, rows, uploads, posted,
    'restricted');
  expect(restricted.attachments).toEqual([]);
  expect(restricted.omittedAttachments).toBe(0);
}
it('excludes saved clean uploads from restricted input', excludesRestrictedAttachments);

async function suppressesHistoricalDelivery(mode: ExecutionMode) {
  const conversationId = `historical-${mode}`;
  const conversation = await saveSession(fixture, { conversationId, mode });
  const upload = await saveUpload(fixture, conversationId);
  const message = await saveInput(fixture, conversationId, mode);
  const lifecycle = await history(fixture.nats.store, 'computer-helper', 'test');
  const assistant = assistantSnapshot(lifecycle, 'team', 'test');
  const socket = new WebSocket(null, undefined, {});
  const send = vi.spyOn(socket, 'send');
  send.mockImplementation(recordFrame);
  const frames: unknown[] = [];
  function recordFrame(data: unknown) {
    frames.push(JSON.parse(String(data)));
  }
  const delivered: string[] = [];
  async function deliver(file: typeof upload.file) {
    delivered.push(file.fileId);
  }
  const link = { connectionId: 1, socket, delivered: new Set<string>(),
    sentTurns: new Map(), sentStops: new Map(), deliver };
  async function connection() {
    return link;
  }
  async function readObject() {
    return Readable.from([upload.bytes]);
  }
  const objectRead = vi.spyOn(fixture.objects, 'getObject');
  objectRead.mockImplementation(readObject);
  const options = { ...fixture.options, objects: fixture.objects };
  await processConversation(options, fixture.tokens, conversation, assistant, new Set(),
    connection);
  expect(frames).toContainEqual(expect.objectContaining({ type: 'turn', id: message.id,
    executionMode: mode, attachments: [] }));
  expect(delivered).toEqual([]);
  expect(objectRead).not.toHaveBeenCalled();
  const rows = await chatHistory(fixture.nats.store, 'test', conversationId);
  expect(rows).toHaveLength(3);
}
it.each(['restricted', 'memory_free'] as const)(
  'keeps historical shared-assistant uploads off the computer in %s mode',
  suppressesHistoricalDelivery);
