import type { StoredEvent } from '@opencrane/event-store';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

// Group only adjacent reply pieces. Never wait for an event beyond the captured history.
export async function* replyBatches(events: AsyncIterable<StoredEvent>) {
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

export async function applyReplyBatch(tx: Query, projection: Projection,
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
