import { recordReport } from '../src/chat/reports.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';

it('records two direct participants, retries without duplicates and never admits an assistant turn', async () => {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/direct-chat-`);
  try {
    const keys = conversationKeys(directory);
    keys.provision('test', 'direct');
    const alice = { silo: 'test', memberId: 'alice' };
    const bob = { silo: 'test', memberId: 'bob' };
    const create = {
      id: 'create', conversationId: 'direct', mode: 'direct' as const, colleagueId: 'bob',
    };
    const original = await chatCommand(nats.store, keys, alice, create);
    expect(await chatCommand(nats.store, keys, alice, create)).toEqual(original);
    await expect(chatCommand(nats.store, keys, alice, { ...create, colleagueId: 'alice' }))
      .rejects.toThrow('Id reused');
    const send = { id: 'hello', conversationId: 'direct', text: 'Hello @agent' };
    const posted = await chatCommand(nats.store, keys, bob, send);
    expect(await chatCommand(nats.store, keys, bob, send)).toEqual(posted);
    const rows = await chatHistory(nats.store, 'test', 'direct');
    expect(rows[0]?.event.data).toEqual({
      conversationId: 'direct', createdBy: 'alice', mode: 'direct', participantIds: ['alice', 'bob'],
    });
    expect(rows.map(eventType)).toEqual(['conversation.created', 'message.posted']);
    expect(keys.decrypt('test', 'direct', rows[1]!.event.data)).toBe('Hello @agent');
    await expect(chatCommand(nats.store, keys, alice, { ...create, colleagueId: 'carol' }))
      .rejects.toThrow('Id reused');
    await expect(chatCommand(nats.store, keys, bob, { ...send, text: 'Changed' }))
      .rejects.toThrow('Id reused');
    await expect(chatCommand(nats.store, keys, { silo: 'test', memberId: 'carol' }, {
      id: 'intrusion', conversationId: 'direct', text: 'Third person',
    })).rejects.toThrow();
    await expect(chatCommand(nats.store, keys, bob, {
      id: 'stop', conversationId: 'direct', stopTurnId: 'hello',
    })).rejects.toThrow();
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function eventType(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
  return row.event.type;
}

it('refuses bridge reports and lifecycle admission for a human conversation', async () => {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/direct-bridge-`);
  try {
    const keys = conversationKeys(directory);
    keys.provision('test', 'direct');
    const person = { silo: 'test', memberId: 'alice' };
    await chatCommand(nats.store, keys, person, {
      id: 'created', conversationId: 'direct', mode: 'direct', colleagueId: 'bob',
    });
    await chatCommand(nats.store, keys, person, {
      id: 'message', conversationId: 'direct', text: 'Hello @agent',
    });
    const computer = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
    const report = {
      sequence: 1, conversationId: 'direct', turnId: 'message',
      assistantId: 'assistant', type: 'agent.turn_started',
    };
    await expect(recordReport(nats.store, keys, computer, report))
      .rejects.toThrow('Human conversation');
    await expect(turnCommand(nats.store, computer, {
      conversationId: 'direct', turnId: 'message', threadId: 'thread', status: 'started',
    })).rejects.toThrow('Human conversation');
    expect(await nats.store.head()).toBe(2);
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
});
