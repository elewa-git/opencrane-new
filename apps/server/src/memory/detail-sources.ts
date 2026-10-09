import { memoryWrittenDataSchema } from '@opencrane/events';
import { isChatRefused } from '../chat/access.ts';
import { MemoryRefused, type MemoryOptions } from './access.ts';
import { messageAccess } from './message-source.ts';
import { z } from 'zod';

type Source = z.infer<typeof memoryWrittenDataSchema>['sources'][number];
type SourceStatus =
  | { status: 'available'; label: "a member's statement" }
  | { status: 'available'; reference: Extract<Source, { conversationId: string }> }
  | { status: 'refused' | 'unavailable' };

export async function sourceStatuses(options: MemoryOptions, requester: string, raw: unknown) {
  const sources = memoryWrittenDataSchema.shape.sources.parse(raw);
  const results: SourceStatus[] = [];
  for (const source of sources) {
    if ('memberId' in source) {
      // Describe the kind of source without revealing who wrote it or their private command.
      const statement: SourceStatus = { status: 'available', label: "a member's statement" };
      results.push(statement);
      continue;
    }
    try {
      await messageAccess(options, requester, source);
      const available: SourceStatus = { status: 'available', reference: source };
      results.push(available);
    } catch (error) {
      let status: 'refused' | 'unavailable' = 'unavailable';
      if (isChatRefused(error) || error instanceof MemoryRefused) {
        status = 'refused';
      }
      const hidden: SourceStatus = { status };
      results.push(hidden);
    }
  }
  return results;
}
