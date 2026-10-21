import type { EventEnvelope } from "@opencrane/events";
import type { StoredEvent } from "@opencrane/event-store";
import { runHandler, type Logger } from "@opencrane/observability";
import type { Db, Query } from "./db.ts";

export interface Projection {
  name: string;
  create(db: Query): Promise<void>;
  drop(db: Query): Promise<void>;
  apply(db: Query, event: EventEnvelope, position: number): Promise<void>;
  /** Apply adjacent reply deltas together without changing their saved order or positions. */
  applyReplies?(db: Query, events: StoredEvent[]): Promise<void>;
  /** Read outside dependencies before opening the transaction; return only database work. */
  prepare?(event: EventEnvelope): Promise<Projection['apply']>;
  /** Record completion only after all events from position one have been applied. */
  completeRebuild?(db: Query): Promise<void>;
  /** Read metadata through a fixed position before any payload preparation. */
  inspectHistory?(events: AsyncIterable<StoredEvent>): Promise<void>;
}
export interface EventSource {
  head(): Promise<number>;
  subscribe(
    fromSequence: number,
    signal?: AbortSignal,
  ): AsyncIterable<StoredEvent>;
}

const replayIdleMs = 1_000;

/** Read finite history without waiting forever when the source reports events it cannot return. */
export async function* readEvents(
  source: EventSource,
  fromSequence: number,
  toSequence: number,
  signal?: AbortSignal,
): AsyncGenerator<StoredEvent> {
  if (fromSequence > toSequence) return;
  const stop = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, stop.signal])
    : stop.signal;
  const iterator = source.subscribe(fromSequence, combined)[Symbol.asyncIterator]();
  let sequence = fromSequence - 1;
  try {
    while (sequence < toSequence) {
      const timeout = AbortSignal.timeout(replayIdleMs);
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) => {
          timeout.addEventListener(
            "abort",
            () => reject(new Error("EVENTS stream is incomplete")),
            { once: true },
          );
        }),
      ]);
      signal?.throwIfAborted();
      if (next.done || next.value.sequence !== sequence + 1) {
        throw new Error("EVENTS stream is incomplete");
      }
      sequence = next.value.sequence;
      yield next.value;
    }
  } finally {
    stop.abort();
    await iterator.return?.();
  }
}

/** One active runner per projection. Handlers must only write through the supplied transaction. */
export class ProjectionRunner {
  private readonly db: Db;
  private readonly source: EventSource;
  private readonly logger: Logger;
  constructor(db: Db, source: EventSource, logger: Logger) {
    this.db = db;
    this.source = source;
    this.logger = logger;
  }

  async initialise(projection: Projection): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(`CREATE TABLE IF NOT EXISTS projection_checkpoints (
        name TEXT PRIMARY KEY, sequence BIGINT NOT NULL CHECK (sequence >= 0))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS projection_events (
        projection TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (projection, event_id))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS projection_generations (
        name TEXT PRIMARY KEY, generation BIGINT NOT NULL CHECK (generation >= 0))`);
      await tx.query(
        "INSERT INTO projection_checkpoints VALUES ($1, 0) ON CONFLICT DO NOTHING",
        [projection.name],
      );
      await tx.query(
        "INSERT INTO projection_generations VALUES ($1, 0) ON CONFLICT DO NOTHING",
        [projection.name],
      );
      await projection.create(tx);
    });
  }

  async checkpoint(projection: Projection): Promise<number> {
    const result = await this.db.query<{ sequence: string | number }>(
      "SELECT sequence FROM projection_checkpoints WHERE name = $1",
      [projection.name],
    );
    if (!result.rows[0]) {
      throw new Error("Projection is not initialised");
    }
    return Number(result.rows[0].sequence);
  }

  private async apply(
    db: Db,
    projection: Projection,
    batch: StoredEvent[],
    attempt: number,
  ): Promise<number> {
    const stored = batch[batch.length - 1]!;
    const event = stored.event;
    async function handleEvent(): Promise<number> {
      const prepared: Projection['apply'][] = [];
      for (const entry of batch) {
        let applyEvent = projection.apply.bind(projection);
        if (projection.prepare) {
          applyEvent = await projection.prepare(entry.event);
        }
        prepared.push(applyEvent);
      }
      async function updateProjection(tx: Query): Promise<number> {
        if (batch.length === 1) {
          return applyPreparedEvent(tx, projection, stored, prepared[0]!);
        }
        return applyReplyBatch(tx, projection, batch, prepared);
      }
      return db.transaction(updateProjection);
    }
    const run = {
      handler: projection.name,
      eventId: event.id,
      eventType: event.type,
      stream: event.subject,
      attempt,
    };
    return runHandler(this.logger, run, handleEvent);
  }

  /** Process events up to the position read when this call began. Stop on failure; retry with a higher attempt. */
  async run(
    projection: Projection,
    {
      signal,
      attempt = 1,
      toSequence,
    }: { signal?: AbortSignal; attempt?: number; toSequence?: number } = {},
  ): Promise<void> {
    let checkpoint = await this.checkpoint(projection);
    const startedFromBeginning = checkpoint === 0;
    const sourceHead = await this.source.head();
    const head = toSequence ?? sourceHead;
    if (!Number.isSafeInteger(head) || head < 0 || head > sourceHead) {
      throw new Error("Invalid replay head");
    }
    if (checkpoint >= head) {
      if (startedFromBeginning) {
        await this.completeRebuild(projection);
      }
      return;
    }
    await projection.inspectHistory?.(readEvents(this.source, 1, head, signal));
    const events = readEvents(this.source, checkpoint + 1, head, signal);
    for await (const batch of replyBatches(events)) {
      signal?.throwIfAborted();
      const apply = this.apply.bind(this);
      async function applyBatch(db: Db) {
        return apply(db, projection, batch, attempt);
      }
      if (this.db.lock) {
        checkpoint = await this.db.lock(projection.name, applyBatch);
      } else {
        checkpoint = await applyBatch(this.db);
      }
      if (checkpoint >= head) {
        break;
      }
    }
    if (startedFromBeginning) {
      await this.completeRebuild(projection);
    }
  }

  private async completeRebuild(projection: Projection): Promise<void> {
    if (!projection.completeRebuild) {
      return;
    }
    const complete = projection.completeRebuild.bind(projection);
    async function recordCompletion(db: Db): Promise<void> {
      await db.transaction(complete);
    }
    if (this.db.lock) {
      await this.db.lock(projection.name, recordCompletion);
    } else {
      await recordCompletion(this.db);
    }
  }

  /** Stop readers and other runners first. Use a separate projection name/tables for an online rebuild. */
  async rebuild(projection: Projection): Promise<void> {
    const head = await this.source.head();
    if (!Number.isSafeInteger(head) || head < 0) {
      throw new Error("Invalid replay head");
    }
    await projection.inspectHistory?.(readEvents(this.source, 1, head));
    await this.checkPreparation(projection, head);
    async function resetTables(tx: Query): Promise<void> {
      await projection.drop(tx);
      await projection.create(tx);
      await tx.query(
        "UPDATE projection_generations SET generation = generation + 1 WHERE name = $1",
        [projection.name],
      );
      await tx.query("DELETE FROM projection_events WHERE projection = $1", [projection.name]);
      await tx.query("UPDATE projection_checkpoints SET sequence = 0 WHERE name = $1",
        [projection.name]);
    }
    await this.db.transaction(resetTables);
    await this.run(projection, { toSequence: head });
  }

  private async checkPreparation(projection: Projection, head: number): Promise<void> {
    if (!projection.prepare) {
      return;
    }
    const prepare = projection.prepare.bind(projection);
    // Check all keys before dropping tables. Discard each result to avoid keeping all memory text.
    for await (const stored of readEvents(this.source, 1, head)) {
      const event = stored.event;
      async function checkEvent(): Promise<void> {
        await prepare(event);
      }
      const run = { handler: projection.name, eventId: event.id, eventType: event.type,
        stream: event.subject, attempt: 1 };
      await runHandler(this.logger, run, checkEvent);
    }
  }
}

async function applyPreparedEvent(
  tx: Query, projection: Projection, stored: StoredEvent, applyEvent: Projection['apply'],
): Promise<number> {
  const checkpoint = await tx.query<{ sequence: string | number }>(
    "SELECT sequence FROM projection_checkpoints WHERE name = $1", [projection.name],
  );
  const sequence = Number(checkpoint.rows[0]?.sequence);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error("Projection is not initialised");
  }
  if (stored.sequence <= sequence) {
    return sequence;
  }
  if (stored.sequence !== sequence + 1) {
    throw new Error("Event sequence gap");
  }
  const event = stored.event;
  const seen = await tx.query(
    "SELECT event_id FROM projection_events WHERE projection = $1 AND event_id = $2",
    [projection.name, event.id],
  );
  if (!seen.rows.length) {
    await applyEvent(tx, event, stored.sequence);
    await tx.query("INSERT INTO projection_events VALUES ($1, $2)", [projection.name, event.id]);
  }
  await tx.query("UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1",
    [projection.name, stored.sequence]);
  return stored.sequence;
}

// Group only adjacent reply pieces. Never wait for an event beyond the captured history.
async function* replyBatches(events: AsyncIterable<StoredEvent>) {
  let batch: StoredEvent[] = [];
  let bytes = 0;
  for await (const stored of events) {
    const streamed = stored.event.type === 'agent.message_delta';
    const size = Buffer.byteLength(JSON.stringify(stored.event));
    if (batch.length && (!streamed || batch.length === 64 || bytes + size > 524_288)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    if (!streamed) {
      yield [stored];
      continue;
    }
    batch.push(stored);
    bytes += size;
  }
  if (batch.length) {
    yield batch;
  }
}

async function applyReplyBatch(tx: Query, projection: Projection,
  batch: StoredEvent[], apply: Projection['apply'][]): Promise<number> {
  const checkpoint = await tx.query<{ sequence: string | number }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', [projection.name]);
  let sequence = Number(checkpoint.rows[0]?.sequence);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error('Projection is not initialised');
  }
  const ids = batch.map(eventId);
  const receipts = await tx.query<{ event_id: string }>(
    'SELECT event_id FROM projection_events WHERE projection = $1 AND event_id = ANY($2::text[])',
    [projection.name, ids]);
  const savedIds = receipts.rows.map(receiptId);
  const seen = new Set(savedIds);
  const added: string[] = [];
  const pending: StoredEvent[] = [];
  for (let index = 0; index < batch.length; index += 1) {
    const stored = batch[index]!;
    // Recheck under the lock: another runner may already have committed this group.
    if (stored.sequence <= sequence) {
      continue;
    }
    if (stored.sequence !== sequence + 1) {
      throw new Error('Event sequence gap');
    }
    if (!seen.has(stored.event.id)) {
      if (projection.applyReplies) {
        pending.push(stored);
      } else {
        const applyEvent = apply[index]!;
        await applyEvent(tx, stored.event, stored.sequence);
      }
      seen.add(stored.event.id);
      added.push(stored.event.id);
    }
    sequence = stored.sequence;
  }
  if (pending.length && projection.applyReplies) {
    await projection.applyReplies(tx, pending);
  }
  if (added.length) {
    await tx.query('INSERT INTO projection_events SELECT $1, unnest($2::text[])',
      [projection.name, added]);
  }
  await tx.query('UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1',
    [projection.name, sequence]);
  return sequence;
}

function eventId(stored: StoredEvent): string {
  return stored.event.id;
}
function receiptId(row: { event_id: string }): string {
  return row.event_id;
}
