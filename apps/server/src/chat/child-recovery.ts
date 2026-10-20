import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { childRequestedEventSchema, chatIdSchema, type ChildRequest } from '@opencrane/events';
import { readEventAt } from '@opencrane/event-store';
import type { Logger } from '@opencrane/observability';
import { isChatRefused, type ChatOptions } from './access.ts';
import { chatHistory } from './commands.ts';
import { childStartFailure, recordChildStartFailure } from './child-failure.ts';
import { createRequestedChild, addChildFirstInput, ChildRequestClosed,
  ChildRequestChanged, ChildRequestRefused, ChildRequestRace } from './child-requests.ts';

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
  const parent = await chatHistory(options.store, options.silo, data.conversationId);
  if (childStartFailure(parent, parsed.data.id)) return;
  const child = await chatHistory(options.store, options.silo, data.childConversationId);
  for (const row of child) {
    if (row.event.id === data.firstInputId) return;
  }
  let stage: 'create' | 'first_input' = 'create';
  try {
    if (child.length === 0) await createRequestedChild(options, data.createdBy, input);
    stage = 'first_input';
    await addChildFirstInput(options, data.createdBy, input);
  } catch (error) {
    const reason = failureReason(error);
    if (!reason) throw error;
    await recordChildStartFailure(options, parsed.data.id, data, stage, reason);
  }
}

function failureReason(error: unknown) {
  if (error instanceof ChildRequestClosed) return 'conversation_closed';
  if (error instanceof ChildRequestRefused || isChatRefused(error)) return 'access_refused';
  if (error instanceof ChildRequestChanged && !(error instanceof ChildRequestRace)) {
    return 'record_changed';
  }
  return undefined;
}

async function recoverPage(options: Options, after: number, logger: Logger, signal: AbortSignal) {
  const result = await options.db.query(`SELECT silo, parent_id, intent_id, intent_position,
    child_id, first_input_id FROM child_requests_v2
    WHERE failed_attempt IS NULL AND silo = $1 AND intent_position > $2
    ORDER BY intent_position LIMIT 32`,
  [options.silo, after]);
  let position = 0;
  let retry = false;
  for (const row of result.rows) {
    if (signal.aborted) {
      return { after: position, retry };
    }
    position = referenceSchema.parse(row).intent_position;
    try {
      await recoverChildRequest(options, row);
    } catch {
      // Keep uncertain outcomes queued. Never log errors containing private input.
      retry = true;
      logger.debug('Saved child request remains queued');
    }
  }
  if (result.rows.length < 32) {
    position = 0;
  }
  return { after: position, retry };
}

export async function watchChildRequests(options: Options, logger: Logger,
  signal: AbortSignal) {
  let after = 0;
  let backoffMs = 1000;
  const runOptions = { signal };
  while (!signal.aborted) {
    try {
      const page = await recoverPage(options, after, logger, signal);
      after = page.after;
      backoffMs = page.retry ? Math.min(backoffMs * 2, 30_000) : 1000;
    } catch {
      if (!signal.aborted) {
        backoffMs = Math.min(backoffMs * 2, 30_000);
        logger.warn('Child recovery is unavailable; requests remain queued');
      }
    }
    try {
      await delay(backoffMs, undefined, runOptions);
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
  }
}

export function startChildRecovery(options: Options, logger: Logger) {
  const stop = new AbortController();
  const work = watchChildRequests(options, logger, stop.signal);
  function failed() {
    logger.fatal('Child recovery stopped; restarting the server');
    process.exit(1);
  }
  void work.catch(failed);
  return async function closeChildRecovery() {
    stop.abort();
    await work;
    logger.info('Child recovery stopped cleanly');
  };
}
