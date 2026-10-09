import { history } from '@opencrane/models';
import { memoryWrittenDataSchema } from '@opencrane/events';
import { chatAccess, isChatRefused } from '../chat/access.ts';
import { MemoryRefused, type MemoryOptions, type Scope } from './access.ts';
import { z } from 'zod';

type Source = z.infer<typeof memoryWrittenDataSchema>['sources'][number];
async function messageAccess(options: MemoryOptions, requester: string,
  source: Extract<Source, { conversationId: string }>) {
  if (!options.chat) {
    throw new Error('Source access unavailable');
  }
  const rows = await history(options.store, `conversation-${source.conversationId}`, options.silo,
    performance.now() + 10_000);
  await chatAccess(options.chat, { memberId: requester, conversationId: source.conversationId });
  function matchesMessage(row: typeof rows[number]) {
    if (row.event.type === 'message.posted') {
      return row.event.id === source.messageId;
    }
    if (row.event.type !== 'agent.message_completed') {
      return false;
    }
    const data = z.object({ messageId: z.string() }).parse(row.event.data);
    return data.messageId === source.messageId;
  }
  if (!rows.some(matchesMessage)) {
    throw new MemoryRefused();
  }
}
export async function checkSources(options: MemoryOptions, requester: string, scope: Scope,
  sources: Source[], commandId: string) {
  for (const source of sources) {
    if ('memberId' in source) {
      if (source.memberId !== requester || source.commandId !== commandId) {
        throw new MemoryRefused();
      }
    } else {
      // Refuse chat sources in shared notes too. Current chats have no durable whole-group audience.
      if (scope.scopeKind !== 'person') {
        throw new MemoryRefused();
      }
      try {
        await messageAccess(options, requester, source);
      } catch (error) {
        if (isChatRefused(error)) {
          throw new MemoryRefused();
        }
        throw error;
      }
    }
  }
}
