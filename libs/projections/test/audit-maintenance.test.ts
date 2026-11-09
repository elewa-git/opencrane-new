import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@opencrane/events';
import { memoryScopeId } from '../src/memory-keys.ts';
import { maintenanceAuditData, maintenanceMetadata,
  maintenanceStatus } from '../src/audit-maintenance.ts';
import { maintenanceOutcome } from '../src/audit-outcomes.ts';

const silo = 'test';
const scopeId = memoryScopeId(silo, 'person', 'owner');
const digest = 'a'.repeat(64);
const data = {
  scopeId, nightId: digest, publicReference: '7f6a9d0e4c329b81',
  batchKey: digest, inputRevision: digest, date: '2026-10-15', bindingRevision: 1,
  memberId: 'owner', acceptedCapCents: 100,
  intendedAt: '2026-10-15T02:00:00.000Z', selectedAt: '2026-10-15T02:01:00.000Z',
  inputRefs: [], action: 'due', reason: null,
};
const event: EventEnvelope = {
  id: digest, commandId: digest, type: 'memory.maintenance_recorded', silo,
  subject: `scope-${scopeId}`, source: 'opencrane-nightly',
  time: '2026-10-15T02:01:00.000Z', principal: { kind: 'system', id: 'nightly-memory' },
  correlation: {}, data,
};

function rejected(changes: Partial<EventEnvelope>, changedData = data): void {
  const candidate = { ...event, ...changes, data: changedData };
  expect(() => maintenanceAuditData(candidate)).toThrow('Invalid maintenance audit event');
}

describe('nightly audit guards', () => {
  it('rejects malformed data, a changed subject and a changed personal binding', () => {
    rejected({}, { ...data, acceptedCapCents: 101 });
    rejected({ subject: 'scope-other' });
    rejected({}, { ...data, memberId: 'admin' });
    rejected({ silo: 'other' });
    rejected({}, { ...data, scopeId: memoryScopeId(silo, 'group', 'owner') });
  });

  it('checks source, principal kind and principal id independently', () => {
    rejected({ source: 'untrusted' });
    rejected({ principal: { kind: 'human', id: 'nightly-memory' } });
    rejected({ principal: { kind: 'system', id: 'other' } });
    rejected({ source: 'opencrane-server' });
  });

  it('requires preflight for prepared and keeps allowance only on prepared', () => {
    const prepared = { ...data, action: 'prepared', rootId: digest,
      model: 'model', providerId: 'provider' };
    rejected({}, prepared);
    const preflight = { ...event, source: 'opencrane-server',
      principal: { kind: 'system' as const, id: 'opencrane-server' }, data: prepared };
    expect(maintenanceAuditData(preflight)).toMatchObject(prepared);
    expect(maintenanceMetadata(prepared).maintenanceAllowanceCents).toBe(100);
    expect(maintenanceMetadata(data).maintenanceAllowanceCents).toBeUndefined();
    expect(() => maintenanceMetadata({ ...data, action: 'unknown' }))
      .toThrow('Invalid maintenance audit event');
  });

  it.each([
    ['due', 'unknown', 'unknown'],
    ['prepared', 'unknown', 'unknown'],
    ['refused', 'not_dispatched', 'not_dispatched'],
    ['missed', 'not_dispatched', 'not_dispatched'],
    ['no_changes', 'recorded', 'recorded'],
  ] as const)('maps %s to %s status and %s outcome', (action, status, outcome) => {
    expect(maintenanceStatus({ action })).toBe(status);
    const record = { maintenanceAction: action } as Parameters<typeof maintenanceOutcome>[0];
    expect(maintenanceOutcome(record)).toBe(outcome);
  });
});
