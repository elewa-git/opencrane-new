import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { EventEnvelope } from '@opencrane/events';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { bridgeChannel } from '../../computer/src/channel.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { chatCommand } from '../src/chat/commands.ts';
import { fileCommand } from '../src/files/commands.ts';

async function refusesQueuedFileAfterRemoval() {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/bridge-file-access-`);
  const server = createServer();
  const keys = conversationKeys(directory);
  keys.provision('test', 'chat');
  const joined = event('joined', 'member-alice', 'member.joined');
  joined.data = { ...joined.data, memberId: 'alice' };
  const assistant: EventEnvelope = event('assistant', 'assistant-assistant', 'assistant.created');
  assistant.data = { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' };
  await nats.seed([joined, assistant]);
  const member = { silo: 'test', memberId: 'alice' };
  const creation = { id: 'create', conversationId: 'chat', assistantId: 'assistant' };
  await chatCommand(nats.store, keys, member, creation);
  const bytes = Buffer.from('Private queued file');
  const hash = createHash('sha256');
  hash.update(bytes);
  const file = { conversationId: 'chat', fileId: 'queued-file', name: 'notes.txt',
    mime: 'text/plain', size: bytes.length, sha256: hash.digest('hex'),
    objectKey: 'test/chat/queued-file', uploadedBy: 'alice' };
  await fileCommand(nats.store, 'test', 'alice', 'upload', 'file.uploaded', file);
  const removed: EventEnvelope = event('removed', 'member-alice', 'member.removed');
  removed.data = { memberId: 'alice', removedBy: 'owner' };
  const invited = event('later-invitation', 'member-alice', 'member.invited');
  invited.data = { ...invited.data, memberId: 'alice' };
  await nats.seed([removed, invited]);
  const before = await nats.store.head('conversation-chat');
  let deliveredBytes = 0;
  function receiveFile(_metadata: unknown, content: Buffer) {
    deliveredBytes += content.length;
    return Promise.resolve();
  }
  function rpc() { return Promise.resolve({}); }
  function grant() { return Promise.resolve(); }
  function credential() { return { value: 'computer', expiresAt: Date.now() + 60_000 }; }
  const driver = { journal: `${directory}/reports`, rpc, grant, credential, file: receiveFile };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No computer port');
  const options = { silo: 'test', store: nats.store, keys };
  const input = { computerId: 'computer', assistantId: 'assistant', bearer: 'computer',
    url: `ws://127.0.0.1:${address.port}/bridge` };
  const link = await connectBridge(options, input);
  try {
    await expect(link.deliver(file, bytes)).rejects.toMatchObject({ kind: 'conversation_refused' });
    expect(deliveredBytes).toBe(0);
    expect(await nats.store.head('conversation-chat')).toBe(before);
  } finally {
    link.socket.terminate();
    await link.settled();
    await channel.close();
    server.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('refuses queued file bytes before sending them to a computer after removal and invitation',
  refusesQueuedFileAfterRemoval);
