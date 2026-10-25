import { createHash } from 'node:crypto';
import { wireSubject } from '@opencrane/event-store';
import { readEvents, type EventSource, type Query } from '@opencrane/projections';
import type { RecoveryState } from './upgrade-recovery-check.ts';

/** Collect private comparison data while the fixture's writers and reactions are stopped. */
export async function collectUpgradeRecovery(source: EventSource, db: Query): Promise<RecoveryState> {
  try {
    const lastSequence = await source.head();
    if (!Number.isSafeInteger(lastSequence) || lastSequence < 1 || lastSequence > 100_000) {
      throw new Error();
    }
    const events: RecoveryState['events'] = [];
    const signal = AbortSignal.timeout(60_000);
    const history = readEvents(source, 1, lastSequence, signal);
    let byteCount = 0;
    for await (const stored of history) {
      const encoded = JSON.stringify(stored.event);
      byteCount += Buffer.byteLength(encoded);
      if (byteCount > 64 * 1024 * 1024) throw new Error();
      const hash = createHash('sha256');
      hash.update(encoded);
      const identity = { sequence: stored.sequence, id: stored.event.id,
        subject: wireSubject(stored.event.subject), eventDigest: hash.digest('hex') };
      events.push(identity);
    }
    const checkpoint = await db.query<{ sequence: string }>(
      "SELECT sequence FROM projection_checkpoints WHERE name = 'members'");
    const hash = createHash('sha256');
    const tables = ['members', 'member_identities', 'member_changes', 'silo_ownership',
      'inventory_inputs', 'inventory_inputs_backfill'];
    for (const table of tables) {
      const rows = await db.query(
        `SELECT * FROM ${table} AS entry ORDER BY to_jsonb(entry)::text COLLATE "C"`);
      hash.update(JSON.stringify([table, rows.rows]));
    }
    if (await source.head() !== lastSequence) throw new Error();
    return { events, checkpoint: Number(checkpoint.rows[0]?.sequence),
      rowsDigest: hash.digest('hex') };
  } catch {
    throw new Error('Upgrade recovery collection refused');
  }
}
