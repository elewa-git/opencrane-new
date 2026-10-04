import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { expect, it } from 'vitest';
import { fileCommand } from '../src/files/commands.ts';
import { FileRefusal } from '../src/files/refusals.ts';

it('returns a typed 403 refusal for delivery without a matching upload', async () => {
  const conversation: StoredEvent = {
    sequence: 1,
    event: {
      id: 'created', commandId: 'created', silo: 'test', subject: 'conversation-conversation',
      type: 'conversation.created', data: { conversationId: 'conversation', createdBy: 'alice' },
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
  const rowsBySubject = new Map([
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
