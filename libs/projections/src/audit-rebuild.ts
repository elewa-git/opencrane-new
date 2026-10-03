import type { Logger } from '@opencrane/observability';
import type { Db } from './db.ts';
import { ProjectionRunner, readEvents, type EventSource } from './runner.ts';
import { auditTrail } from './audit.ts';

/** Replace the metadata and checkpoint in one transaction. Replay never imports effect reactions. */
export async function rebuildAuditProjection(db: Db, source: EventSource, logger: Logger, { verify = false } = {}) {
  if (!db.lock) throw new Error('Audit rebuild requires projection locking');
  await new ProjectionRunner(db, source, logger).initialise(auditTrail);
  return db.lock(auditTrail.name, async locked => {
    const runner = new ProjectionRunner(locked, source, logger);
    const checkpoint = await runner.checkpoint(auditTrail), head = await source.head();
    return locked.transaction(async tx => {
      const before = (await tx.query('SELECT * FROM audit_entries ORDER BY silo, event_id')).rows;
      await tx.query('TRUNCATE audit_entries');
      await tx.query('DELETE FROM projection_events WHERE projection = $1', [auditTrail.name]);
      const apply = async (from: number, to: number) => {
        for await (const row of readEvents(source, from, to)) {
          await auditTrail.apply(tx, row.event, row.sequence);
          await tx.query('INSERT INTO projection_events VALUES ($1,$2) ON CONFLICT DO NOTHING', [auditTrail.name, row.event.id]);
        }
      };
      await apply(1, checkpoint);
      const rebuilt = (await tx.query('SELECT * FROM audit_entries ORDER BY silo, event_id')).rows;
      const changed = JSON.stringify(before) !== JSON.stringify(rebuilt);
      if (verify && changed) throw new Error('Rebuilt audit differs from the live projection');
      await apply(checkpoint + 1, head);
      await tx.query('UPDATE projection_checkpoints SET sequence = $2 WHERE name = $1', [auditTrail.name, head]);
      if (changed) await tx.query('UPDATE projection_generations SET generation = generation + 1 WHERE name = $1', [auditTrail.name]);
      return { previousSequence: checkpoint, sequence: head, verified: verify, changed };
    });
  });
}
