import { memoryWrittenDataSchema } from '@opencrane/events';
import { isChatRefused } from '../chat/access.ts';
import { MemoryRefused, type MemoryOptions, type Scope } from './access.ts';
import { z } from 'zod';
import { messageAccess } from './message-source.ts';

type Source = z.infer<typeof memoryWrittenDataSchema>['sources'][number];
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
