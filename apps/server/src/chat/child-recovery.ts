import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { childRequestedEventSchema, chatIdSchema, type ChildRequest } from '@opencrane/events';
import { readEventAt } from '@opencrane/event-store';
import type { Logger } from '@opencrane/observability';
import type { ChatOptions } from './access.ts';
import { createRequestedChild, addChildFirstInput } from './child-requests.ts';

type Options = Pick<ChatOptions, 'store' | 'silo' | 'binding' | 'db' | 'keys'>;
const referenceSchema = z.strictObject({
  silo: z.string(), parent_id: chatIdSchema, intent_id: chatIdSchema,
  intent_position: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  child_id: chatIdSchema, first_input_id: chatIdSchema,
});
function participantId(join: ChildRequest['initialJoins'][number]) {
  return join.participantId;
}
export async function recoverChildRequest(options: Options, value: unknown) {
  const reference = referenceSchema.parse(value);
  if (reference.silo !== options.silo) {
    throw new Error('Child recovery reference unavailable');
  }
  const subject = `conversation-${reference.parent_id}`;
  const row = await readEventAt(options.store, subject, reference.intent_position,
    performance.now() + 10_000);
  const parsed = childRequestedEventSchema.safeParse(row?.event);
  if (!parsed.success || parsed.data.silo !== options.silo ||
      parsed.data.subject !== subject || parsed.data.id !== reference.intent_id ||
      parsed.data.data.childConversationId !== reference.child_id ||
      parsed.data.data.firstInputId !== reference.first_input_id) {
    throw new Error('Child recovery reference unavailable');
  }
  // Derive every choice from the saved intent, never from the index or a queue row.
  const data = parsed.data.data;
  const input = { conversationId: data.conversationId, sourceMessageId: data.sourceMessageId,
    requestId: data.requestId, assistantId: data.assistantId, payingGroupId: data.payingGroupId,
    allowanceBoundCents: data.allowanceBoundCents,
    participantIds: data.initialJoins.map(participantId) };
  await createRequestedChild(options, data.createdBy, input);
  await addChildFirstInput(options, data.createdBy, input);
}

async function recoverPage(options: Options, after: number, logger: Logger, signal: AbortSignal) {
  const result = await options.db.query(`SELECT * FROM child_requests
    WHERE silo = $1 AND intent_position > $2 ORDER BY intent_position LIMIT 32`,
  [options.silo, after]);
  let position = 0;
  for (const row of result.rows) {
    if (signal.aborted) {
      return position;
    }
    position = referenceSchema.parse(row).intent_position;
    try {
      await recoverChildRequest(options, row);
    } catch {
      // Keep refusals and uncertain outcomes queued. Never log errors containing private input.
      logger.debug('Saved child request remains queued');
    }
  }
  if (result.rows.length < 32) {
    return 0;
  }
  return position;
}

export async function watchChildRequests(options: Options, logger: Logger,
  signal: AbortSignal) {
  let after = 0;
  const runOptions = { signal };
  while (!signal.aborted) {
    try {
      after = await recoverPage(options, after, logger, signal);
    } catch {
      if (!signal.aborted) {
        logger.warn('Child recovery is unavailable; requests remain queued');
      }
    }
    try {
      await delay(1000, undefined, runOptions);
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
  }
}
