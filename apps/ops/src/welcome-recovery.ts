import { isDeepStrictEqual } from 'node:util';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { Handler, HandlerRuntime } from '@opencrane/handlers';
import { readEvents, type EventSource, type Query } from '@opencrane/projections';

function isWelcomeHandler(handler: HandlerRuntime['options']['handlers'][number]) {
  return handler.name === 'complete-welcome';
}

function updatePending(pending: Map<string, EventEnvelope>, event: EventEnvelope) {
  if (event.type === 'onboarding.welcome_answer_recorded') {
    if (!parseEventByType(event).success) throw new Error('Invalid saved welcome answer');
    pending.set(event.subject, event);
    return;
  }
  if (event.type === 'onboarding.welcome_started' ||
      event.type === 'onboarding.completed' ||
      event.type === 'onboarding.survey_restarted' ||
      event.type === 'onboarding.survey_step_saved') {
    pending.delete(event.subject);
  }
}

async function restorePending(runtime: HandlerRuntime, handler: Handler,
  pending: EventEnvelope[]) {
  let restored = 0;
  for (let start = 0; start < pending.length; start += 256) {
    const batch = pending.slice(start, start + 256);
    async function restoreBatch(transaction: Query) {
      for (const answer of batch) {
        const jobs = await transaction.query<{ data: unknown }>(
          "SELECT data FROM pgboss.job WHERE name='complete-welcome' AND data->>'id'=$1 LIMIT 1",
          [answer.id],
        );
        const savedJob = jobs.rows[0];
        if (savedJob && !isDeepStrictEqual(savedJob.data, answer)) {
          throw new Error('Welcome recovery job differs from saved answer');
        }
        const receipts = await transaction.query(
          "SELECT 1 FROM handler_receipts WHERE handler='complete-welcome' AND event_id=$1",
          [answer.id],
        );
        if (savedJob || receipts.rows.length) continue;
        await runtime.enqueue(handler, answer, transaction);
        restored++;
      }
    }
    await runtime.options.db.transaction(restoreBatch);
  }
  return restored;
}

/** Restore unfinished welcome delivery from saved events before starting queue workers. */
export async function recoverWelcomeCompletion(runtime: HandlerRuntime,
  source: EventSource): Promise<number> {
  const handler = runtime.options.handlers.find(isWelcomeHandler);
  if (!handler) return 0;
  const pending = new Map<string, EventEnvelope>();
  const head = await source.head();
  for (let start = 1; start <= head; start += 256) {
    const end = Math.min(start + 255, head);
    for await (const row of readEvents(source, start, end)) {
      if (row.event.silo !== runtime.options.silo) {
        throw new Error('Welcome recovery silo mismatch');
      }
      updatePending(pending, row.event);
    }
  }
  let restored = await restorePending(runtime, handler, [...pending.values()]);
  const failed = await runtime.options.db.query<{ id: string }>(
    "SELECT id FROM pgboss.job WHERE name='complete-welcome' AND state='failed'",
  );
  const retryOptions = { resetRetries: true };
  for (const job of failed.rows) {
    // Keep the original job so later events on its stream cannot pass it.
    await runtime.replay(handler.name, job.id, retryOptions);
    restored++;
  }
  return restored;
}
