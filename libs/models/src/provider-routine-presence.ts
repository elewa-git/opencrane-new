import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';

const progressSchema = z.object({
  sequence: z.coerce.number().int().nonnegative(),
  generation: z.coerce.number().int().nonnegative(),
});
const positionSchema = z.coerce.number().int().positive();

async function progress(db: Query, deadline: number) {
  const queryOptions = { deadline };
  const result = await db.query(`SELECT sequence, generation FROM projection_checkpoints
    JOIN projection_generations USING (name) WHERE name = $1`, ['routines'], queryOptions);
  return progressSchema.parse(result.rows[0]);
}

export async function providerRoutinePresence(store: EventStore, db: Query,
  silo: string, deadline: number) {
  const position = await store.head('routine-*', deadline);
  const before = await progress(db, deadline);
  if (before.sequence < position) {
    throw new Error('Routine presence unavailable');
  }
  const queryOptions = { deadline };
  // Use the silo-position index without fetching definitions or counting every routine.
  const result = await db.query(`SELECT position FROM routines
    WHERE silo = $1 ORDER BY position DESC LIMIT 1`, [silo], queryOptions);
  let status: 'absent' | 'unsupported' = 'absent';
  if (result.rows.length > 0) {
    const recordedPosition = positionSchema.parse(result.rows[0]?.['position']);
    if (recordedPosition > position) {
      throw new Error('Routine presence unavailable');
    }
    status = 'unsupported';
  }
  const after = await progress(db, deadline);
  const latest = await store.head('routine-*', deadline);
  // Reject rebuilds and new routine events, while allowing unrelated projection progress.
  if (after.generation !== before.generation || after.sequence < position || latest !== position) {
    throw new Error('Routine presence unavailable');
  }
  return { status, position };
}
