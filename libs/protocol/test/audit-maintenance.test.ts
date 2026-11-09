import { expect, it } from 'vitest';
import { auditRecordSchema } from '../src/audit.ts';

const record = {
  eventId: '7f6a9d0e4c329b817f6a9d0e4c329b81',
  type: 'memory.maintenance_recorded', position: 1,
  source: 'authoritative', status: 'unknown',
  maintenanceAction: 'prepared', maintenanceScopeKind: 'person',
  maintenanceReference: '7f6a9d0e4c329b817f6a9d0e4c329b81',
  maintenanceScopeId: 'a'.repeat(64), maintenanceRootId: 'b'.repeat(64),
  maintenanceAllowanceCents: 100,
  taskHref: `/api/memory/${'a'.repeat(64)}/maintenance`,
};

it('accepts only checked nightly audit fields', () => {
  expect(auditRecordSchema.safeParse(record).success).toBe(true);
  expect(auditRecordSchema.safeParse({ ...record, maintenanceAction: 'ran' }).success)
    .toBe(false);
  expect(auditRecordSchema.safeParse({ ...record, maintenanceScopeKind: 'group' }).success)
    .toBe(false);
  expect(auditRecordSchema.safeParse({ ...record, maintenanceScopeId: 'short' }).success)
    .toBe(false);
  expect(auditRecordSchema.safeParse({ ...record, maintenanceRootId: 'short' }).success)
    .toBe(false);
  expect(auditRecordSchema.safeParse({ ...record, maintenanceAllowanceCents: -1 }).success)
    .toBe(false);
  expect(auditRecordSchema.safeParse({ ...record,
    maintenanceAllowanceCents: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  expect(auditRecordSchema.safeParse({ ...record, taskHref: '/api/memory/other/maintenance' })
    .success).toBe(false);
});
