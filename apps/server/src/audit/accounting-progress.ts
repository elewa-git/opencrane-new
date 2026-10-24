import { z } from 'zod';
import { auditRecordSchema, type AuditRecord } from '@opencrane/protocol';
import type { Query } from '@opencrane/projections';

const position = z.coerce.number().int().nonnegative().safe();
const snapshotSchema = z.object({
  permitId: z.string().regex(/^[\w-]{1,200}$/u), metadata: auditRecordSchema,
  version: z.number().int().min(5), sequence: position, generation: position,
  callSilo: z.string().nullable(), reservationId: z.string().nullable(),
  callPermitId: z.string().nullable(), callPosition: position.nullable(),
  heldCents: position.nullable(), settledCents: position.nullable(),
  state: z.enum(['held', 'settled', 'unknown', 'not_dispatched']).nullable(),
});
type CurrentAccounting = NonNullable<AuditRecord['currentAccounting']>;

function checkedResolution(record: AuditRecord): boolean {
  return record.type === 'effect.resolved' && record.savedOutcome !== undefined &&
    record.actor?.kind === 'person' && record.source === 'authoritative' &&
    record.status === 'recorded';
}

async function readAccounting(db: Query, silo: string, record: AuditRecord,
  deadline: number): Promise<CurrentAccounting> {
  const checkedAt = new Date().toISOString();
  try {
    // Read the call and its progress together so a rebuild cannot mix two versions.
    // Reuse the permit binding checked when the resolution entered the audit table.
    const result = await db.query(`SELECT a.permit_id AS "permitId", a.metadata,
        v.version, p.sequence, g.generation, c.silo AS "callSilo",
        c.reservation_id AS "reservationId", c.permit_id AS "callPermitId",
        c.position AS "callPosition", c.held_cents AS "heldCents",
        c.settled_cents AS "settledCents", c.evidence AS state
      FROM audit_entries a
      JOIN projection_versions v ON v.name = 'model-budgets'
      JOIN projection_checkpoints p ON p.name = v.name
      JOIN projection_generations g ON g.name = v.name
      LEFT JOIN model_budget_calls c ON c.silo = a.silo AND c.reservation_id = a.permit_id
      WHERE a.silo = $1 AND a.event_id = $2 AND a.position = $3`,
    [silo, record.eventId, record.position], { deadline });
    const parsed = snapshotSchema.safeParse(result.rows[0]);
    if (!parsed.success || !checkedResolution(parsed.data.metadata)) {
      return { status: 'unavailable', checkedAt };
    }
    const row = parsed.data;
    const progress = { checkedAt, sequence: row.sequence, generation: row.generation };
    if (row.sequence < record.position || row.callSilo === null) {
      return { status: 'applying', ...progress };
    }
    if (row.callSilo !== silo || row.reservationId !== row.permitId ||
        row.callPermitId !== row.permitId || row.callPosition === null ||
        row.callPosition > row.sequence || row.heldCents === null || row.state === null) {
      return { status: 'unavailable', checkedAt };
    }
    // Describe current money only. Equal amounts and positions prove no causal link.
    return { status: 'current', ...progress, state: row.state,
      heldCents: row.heldCents, settledCents: row.settledCents };
  } catch {
    // Keep the saved choice readable without exposing database errors or private data.
    return { status: 'unavailable', checkedAt };
  }
}

export async function readAccountingProgress(db: Query, silo: string, records: AuditRecord[]) {
  const deadline = performance.now() + 2000;
  for (const record of records) {
    if (checkedResolution(record)) {
      record.currentAccounting = await readAccounting(db, silo, record, deadline);
    }
  }
}
