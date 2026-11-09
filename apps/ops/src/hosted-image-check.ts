import { isDeepStrictEqual } from 'node:util';
import { getEventDefinition, hostedImageCheckRequestedSchema,
  type EventEnvelope } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { registerHandler, type Handler, type HandlerRuntime } from '@opencrane/handlers';
import { readHostedImageScanAttempt } from '@opencrane/models';
import { readEvents, type EventSource, type Query } from '@opencrane/projections';
import { z } from 'zod';

export type Scan = (store: EventStore, silo: string, serverId: string, attemptId: number,
  prepareImage: (attempt: unknown, signal?: AbortSignal) => Promise<unknown>,
  readSettings: () => Promise<unknown>,
  readIndependentChecks: (attempt: unknown, signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal) => Promise<{ status: string }>;
export type Inputs = {
  prepareImage: Parameters<Scan>[4];
  readSettings: Parameters<Scan>[5];
  readIndependentChecks: Parameters<Scan>[6];
};
type ReadInputs = (event: EventEnvelope) => Promise<Inputs>;

function requestedAttempt(event: EventEnvelope): number | undefined {
  if (event.type === 'mcp.server_registered') {
    const definition = getEventDefinition(event.type);
    const parsed = definition?.dataSchema.safeParse(event.data);
    if (!parsed?.success || event.principal?.kind !== 'human') return;
    const data = z.record(z.string(), z.unknown()).parse(parsed.data);
    if (data['kind'] !== 'hosted' || !data['installation'] ||
        data['registeredBy'] !== event.principal.id) return;
    return 1;
  }
  if (event.type === 'mcp.image_check_requested') {
    const parsed = hostedImageCheckRequestedSchema.safeParse(event.data);
    if (!parsed.success || event.principal?.kind !== 'human') return;
    return parsed.data.attemptId;
  }
  return;
}

async function savedTrigger(store: EventStore, silo: string, trigger: EventEnvelope) {
  if (trigger.silo !== silo || !trigger.subject.startsWith('mcp-')) return false;
  const serverId = trigger.subject.slice(4);
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(trigger.subject, 1, deadline)) {
    if (row.event.id === trigger.id) {
      return row.event.silo === silo && row.event.subject === `mcp-${serverId}` &&
        isDeepStrictEqual(row.event, trigger);
    }
  }
  return false;
}

export function hostedImageCheckHandler(store: EventStore, silo: string, scan: Scan,
  readInputs: ReadInputs): Handler {
  async function handle(trigger: EventEnvelope, _transaction: Query,
    attempt?: { signal: AbortSignal }) {
    const number = requestedAttempt(trigger);
    if (!number || !(await savedTrigger(store, silo, trigger))) return;
    const serverId = trigger.subject.slice(4);
    const saved = await readHostedImageScanAttempt(store, silo, serverId);
    if (!saved || saved.attemptId !== number) return;
    // Read trusted settings before claiming the one scan. Missing custody must not consume it.
    const inputs = await readInputs(trigger);
    const result = await scan(store, silo, serverId, number, inputs.prepareImage,
      inputs.readSettings, inputs.readIndependentChecks, attempt?.signal);
    if (result.status !== 'appended') {
      throw new Error('Hosted image check unavailable');
    }
  }
  return registerHandler('check-hosted-image', handle);
}

function isImageHandler(handler: Handler) {
  return handler.name === 'check-hosted-image';
}

async function restorePending(runtime: HandlerRuntime, handler: Handler,
  pending: EventEnvelope[]) {
  let restored = 0;
  for (let start = 0; start < pending.length; start += 256) {
    const batch = pending.slice(start, start + 256);
    async function restoreBatch(transaction: Query) {
      for (const event of batch) {
        const jobs = await transaction.query<{ data: unknown }>(
          "SELECT data FROM pgboss.job WHERE name='check-hosted-image' AND data->>'id'=$1 LIMIT 1",
          [event.id],
        );
        if (jobs.rows[0] && !isDeepStrictEqual(jobs.rows[0].data, event)) {
          throw new Error('Image recovery job differs from saved event');
        }
        const receipts = await transaction.query(
          "SELECT 1 FROM handler_receipts WHERE handler='check-hosted-image' AND event_id=$1",
          [event.id],
        );
        if (jobs.rows.length || receipts.rows.length) continue;
        await runtime.enqueue(handler, event, transaction);
        restored++;
      }
    }
    await runtime.options.db.transaction(restoreBatch);
  }
  return restored;
}

/** Restore missing jobs from saved attempts without fetching image bytes or scanning. */
export async function recoverHostedImageChecks(runtime: HandlerRuntime, source: EventSource,
  store: EventStore) {
  const handler = runtime.options.handlers.find(isImageHandler);
  if (!handler) return 0;
  const pending = new Map<string, EventEnvelope>();
  const head = await source.head();
  for (let start = 1; start <= head; start += 256) {
    const end = Math.min(start + 255, head);
    for await (const row of readEvents(source, start, end)) {
      const event = row.event;
      if (event.silo !== runtime.options.silo) {
        throw new Error('Image recovery silo mismatch');
      }
      if (requestedAttempt(event)) pending.set(event.subject, event);
    }
  }
  const candidates: EventEnvelope[] = [];
  for (const event of pending.values()) {
    const serverId = event.subject.slice(4);
    const attempt = await readHostedImageScanAttempt(store, runtime.options.silo, serverId);
    if (attempt?.attemptId === requestedAttempt(event)) candidates.push(event);
  }
  let restored = await restorePending(runtime, handler, candidates);
  const failed = await runtime.options.db.query<{ id: string }>(
    "SELECT id FROM pgboss.job WHERE name='check-hosted-image' AND state='failed'",
  );
  for (const job of failed.rows) {
    await runtime.replay(handler.name, job.id, { resetRetries: true });
    restored++;
  }
  return restored;
}
