import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryMaintenanceBoundDataSchema, memoryMaintenanceRecordedDataSchema,
  parseEventByType } from '@opencrane/events';
import { history, providerTurnAdmission } from '@opencrane/models';
import type { MemoryOptions } from './access.ts';

type Run = ReturnType<typeof memoryMaintenanceRecordedDataSchema.parse>;
type Binding = ReturnType<typeof memoryMaintenanceBoundDataSchema.parse>;
type Reason = 'binding_changed' | 'input_changed' | 'provider_unavailable' |
  'scope_occupied' | 'window_missed';

function digest(value: unknown): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

function savedReceipt(run: Run) {
  return { outcome: 'refused' as const, nightId: run.nightId, reason: run.reason,
    dispatch: 'disabled' as const };
}

function inspectRun(row: StoredEvent, nightId: string, intent: Run | undefined) {
  const run = memoryMaintenanceRecordedDataSchema.parse(row.event.data);
  if (run.nightId === nightId && !intent) {
    if (row.event.source !== 'opencrane-nightly' ||
        row.event.principal?.kind !== 'system' ||
        row.event.principal.id !== 'nightly-memory') {
      throw new Error('Maintenance intent unavailable');
    }
    return { intent: run, result: undefined, occupied: false };
  }
  const result = run.nightId === nightId && row.event.source === 'opencrane-server'
    ? run : undefined;
  const occupied = run.nightId !== nightId && run.action === 'due';
  return { intent, result, occupied };
}

function originalNight(rows: StoredEvent[], nightId: string) {
  let intent: Run | undefined;
  let binding: Binding | undefined;
  let result: Run | undefined;
  let changedBinding = false;
  let changedInput = false;
  let occupied = false;
  for (const row of rows) {
    if (row.event.type === 'memory.maintenance_bound') {
      binding = memoryMaintenanceBoundDataSchema.parse(row.event.data);
      if (intent) changedBinding = true;
      continue;
    }
    if (row.event.type === 'memory.maintenance_recorded') {
      const next = inspectRun(row, nightId, intent);
      intent = next.intent;
      result = next.result ?? result;
      occupied ||= next.occupied;
      continue;
    }
    if (intent && ['memory.written', 'memory.corrected', 'memory.forgotten'].includes(
      row.event.type)) {
      changedInput = true;
    }
  }
  return { intent, binding, result, changedBinding, changedInput, occupied };
}

function matchesOriginalInputs(rows: StoredEvent[], intent: Run): boolean {
  for (const reference of intent.inputRefs) {
    let matching = false;
    for (const row of rows) {
      if (row.sequence !== reference.position) continue;
      if (row.event.type !== 'memory.written' && row.event.type !== 'memory.corrected') {
        return false;
      }
      const data = z.record(z.string(), z.unknown()).parse(row.event.data);
      matching = data['memoryId'] === reference.memoryId &&
        data['revision'] === reference.revision &&
        data['expiresAt'] === reference.expiresAt;
    }
    if (!matching) return false;
  }
  return true;
}

function preflightReason(state: ReturnType<typeof originalNight>, rows: StoredEvent[],
  intent: Run, now: Date): Reason | null {
  const binding = state.binding;
  if (!binding || !binding.enabled || binding.revision !== intent.bindingRevision ||
      binding.memberId !== intent.memberId || state.changedBinding) {
    return 'binding_changed';
  }
  if (state.changedInput || !matchesOriginalInputs(rows, intent)) return 'input_changed';
  if (state.occupied) return 'scope_occupied';
  if (now.getTime() >= Date.parse(intent.intendedAt) + 15 * 60_000) {
    return 'window_missed';
  }
  return null;
}

async function saveRefusal(options: MemoryOptions, rows: StoredEvent[], intent: Run,
  reason: Reason, clock: () => Date) {
  const time = clock().toISOString();
  const action = reason === 'window_missed' ? 'missed' : 'refused';
  const data = memoryMaintenanceRecordedDataSchema.parse({
    ...intent, action, reason, selectedAt: time,
  });
  const id = digest([intent.nightId, 'preflight']);
  const event = { id, commandId: id, subject: `scope-${intent.scopeId}`,
    silo: options.silo, source: 'opencrane-server', time,
    type: 'memory.maintenance_recorded',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    correlation: {}, data };
  if (!parseEventByType(event).success) throw new Error('Invalid maintenance result');
  const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0,
    historyChecked: true as const };
  try {
    const result = await options.store.append(command);
    if (result.status === 'appended') return savedReceipt(data);
  } catch {
    // Read the original result on redelivery when the append reply was lost.
  }
  return { outcome: 'unknown' as const, nightId: intent.nightId,
    dispatch: 'disabled' as const };
}

export async function prepareNightlyMaintenance(options: MemoryOptions, scopeId: string,
  nightId: string, clock: () => Date = () => new Date()) {
  // Read the growing scope history before any later short access check is added.
  const rows = await history(options.store, `scope-${scopeId}`, options.silo,
    performance.now() + 10_000);
  const state = originalNight(rows, nightId);
  const intent = state.intent;
  if (!intent || !validIntent(intent, scopeId, nightId)) {
    throw new Error('Maintenance night unavailable');
  }
  if (state.result) return savedReceipt(state.result);
  const reason = preflightReason(state, rows, intent, clock());
  if (reason) return saveRefusal(options, rows, intent, reason, clock);
  const assistantId = state.binding?.assistantId;
  if (!assistantId) throw new Error('Maintenance binding unavailable');
  try {
    if (!await managedRouteAvailable(options, assistantId)) {
      return saveRefusal(options, rows, intent, 'provider_unavailable', clock);
    }
  } catch {
    return { outcome: 'unknown' as const, nightId, dispatch: 'disabled' as const };
  }
  // Wait for checked root admission. A provider choice alone cannot allocate capacity.
  return { outcome: 'pending' as const, nightId, reason: 'qualification_blocked' as const,
    dispatch: 'disabled' as const };
}

function validIntent(intent: Run, scopeId: string, nightId: string): boolean {
  if (intent.scopeId !== scopeId || intent.nightId !== nightId) return false;
  return intent.action === 'due' || intent.reason === 'qualification_blocked';
}

async function managedRouteAvailable(options: MemoryOptions, assistantId: string) {
  const admission = await providerTurnAdmission(options.store, options.silo,
    assistantId, performance.now() + 10_000);
  return admission.enabled && !admission.draining && !!admission.choice &&
    admission.choice.state === 'active';
}
