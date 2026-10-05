import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { expect, it } from 'vitest';
import { fileCommand } from '../src/files/commands.ts';
import { FileRefusal } from '../src/files/refusals.ts';

async function malformedCommand() {
  const store = {
    async *readStream() {
      await Promise.resolve();
      yield* [] as StoredEvent[];
      throw new Error('Malformed input must be refused before reading');
    },
    async append() {
      await Promise.resolve();
      throw new Error('Malformed input must be refused before appending');
    },
  } satisfies Pick<EventStore, 'readStream' | 'append'>;
  const malformed = { conversationId: 'conversation' };
  const command = fileCommand(store, 'test', 'alice', 'malformed', 'file.uploaded', malformed);
  await expect(command).rejects.toBeInstanceOf(FileRefusal);
  await expect(command).rejects.toMatchObject({ kind: 'invalid_request', statusCode: 400 });
}

it('refuses malformed command input with typed 400 before reading or appending', malformedCommand);

it('returns a typed 403 refusal for delivery without a matching upload', async () => {
  const conversation: StoredEvent = {
    sequence: 1,
    event: {
      id: 'created', commandId: 'created', silo: 'test', subject: 'conversation-conversation',
      type: 'conversation.created', data: { conversationId: 'conversation', createdBy: 'alice', assistantId: 'personal' },
      correlation: {},
      principal: { kind: 'human', id: 'alice' }, source: 'test', time: new Date().toISOString(),
    },
  };
  const membership: StoredEvent = {
    sequence: 1,
    event: {
      id: 'joined', commandId: 'joined', silo: 'test', subject: 'member-alice',
      type: 'member.joined', data: { memberId: 'alice' },
      correlation: {},
      principal: { kind: 'human', id: 'alice' }, source: 'test', time: new Date().toISOString(),
    },
  };
  const assistant: StoredEvent = { ...conversation, event: { ...conversation.event,
    type: 'assistant.created', subject: 'assistant-personal',
    data: { assistantId: 'personal', ownerId: 'alice', kind: 'personal' },
  } };
  const rowsBySubject = new Map([
    ['assistant-personal', [assistant]],
    ['conversation-conversation', [conversation]],
    ['member-alice', [membership]],
  ]);
  const store = {
    async *readStream(subject: string) {
      await Promise.resolve();
      for (const row of rowsBySubject.get(subject) ?? []) {
        yield row;
      }
    },
    async append(_command: Parameters<EventStore['append']>[0]) {
      await Promise.resolve();
      throw new Error('Delivery refusal must happen before append');
    },
  } satisfies Pick<EventStore, 'readStream' | 'append'>;

  let refusal: unknown;
  try {
    await fileCommand(store, 'test', 'alice', 'delivery-event', 'file.delivered', {
      conversationId: 'conversation', fileId: 'missing-file', computerId: 'computer',
      sha256: 'a'.repeat(64),
    });
  } catch (error) {
    refusal = error;
  }

  expect(refusal).toBeInstanceOf(FileRefusal);
  expect(refusal).toMatchObject({ kind: 'delivery_refused', statusCode: 403 });
});
