import { expect, it } from 'vitest';
import { auditRecordSchema } from '../src/audit.ts';

function savedOutcome() {
  const base = { eventId: 'resolution', type: 'effect.resolved', position: 1,
    source: 'authoritative', status: 'recorded', amountCents: 0 };
  expect(auditRecordSchema.safeParse(base).success).toBe(true);
  for (const outcome of ['settled', 'released']) {
    const record = { ...base, savedOutcome: outcome };
    expect(auditRecordSchema.parse(record)).toEqual(record);
  }
  for (const outcome of ['success', '', null, 0]) {
    expect(auditRecordSchema.safeParse({ ...base, savedOutcome: outcome }).success).toBe(false);
  }
  const extra = { ...base, savedOutcome: 'settled', evidence: 'private' };
  expect(auditRecordSchema.safeParse(extra).success).toBe(false);
}
it('accepts only saved monetary outcomes and retains strict older audit records', savedOutcome);
