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

function currentAccounting() {
  const base = { eventId: 'resolution', type: 'effect.resolved', position: 1,
    source: 'authoritative', status: 'recorded' };
  const checkedAt = '2026-10-24T12:00:00.000Z';
  const accounting = { status: 'current', state: 'held', heldCents: 120,
    settledCents: null, checkedAt, sequence: 8, generation: 0 };
  const record = { ...base, currentAccounting: accounting };
  expect(auditRecordSchema.parse(record)).toEqual(record);
  for (const status of ['applying', 'unavailable']) {
    const pending = { ...base, currentAccounting: { status, checkedAt } };
    expect(auditRecordSchema.parse(pending)).toEqual(pending);
  }
  const invalid = [
    { ...accounting, heldCents: -1 }, { ...accounting, settledCents: 0.5 },
    { ...accounting, settledCents: Number.MAX_SAFE_INTEGER + 1 },
    { ...accounting, sequence: -1 }, { ...accounting, generation: 0.5 },
    { ...accounting, checkedAt: 'yesterday' }, { ...accounting, state: 'released' },
    { ...accounting, evidence: 'private' }, { ...accounting, completed: true },
    { status: 'applying', checkedAt, heldCents: 0 },
  ];
  for (const currentAccounting of invalid) {
    expect(auditRecordSchema.safeParse({ ...base, currentAccounting }).success).toBe(false);
  }
}
it('keeps current accounting strict, optional and separate from the saved choice', currentAccounting);
