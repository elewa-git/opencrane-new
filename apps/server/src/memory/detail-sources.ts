import { history } from '@opencrane/models';
import { memoryWrittenDataSchema } from '@opencrane/events';
import { chatAccess, isChatRefused } from '../chat/access.ts';
import { MemoryRefused, type MemoryOptions } from './access.ts';
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
    if (row.event.type === 'message.posted') return row.event.id === source.messageId;
    if (row.event.type !== 'agent.message_completed') return false;
    const data = z.object({ messageId: z.string() }).parse(row.event.data);
    return data.messageId === source.messageId;
  }
  if (!rows.some(matchesMessage)) {
    throw new MemoryRefused();
  }
}
export async function sourceStatuses(options: MemoryOptions, requester: string, raw: unknown) {
  const sources = memoryWrittenDataSchema.shape.sources.parse(raw);
  const results: { status: string; reference?: Source }[] = [];
  for (const source of sources) {
    try {
      if ('conversationId' in source) {
        await messageAccess(options, requester, source);
      }
      results.push({ status: 'available', reference: source });
    } catch (error) {
      let status = 'unavailable';
      if (isChatRefused(error) || error instanceof MemoryRefused) {
        status = 'refused';
      }
      results.push({ status });
    }
  }
  return results;
}
