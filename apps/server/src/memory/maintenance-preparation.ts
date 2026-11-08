import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryMaintenanceBoundDataSchema, memoryMaintenanceRecordedDataSchema,
  budgetRootAllowanceSetDataSchema, parseEventByType } from '@opencrane/events';
import { history, providerTurnAdmission } from '@opencrane/models';
import type { MemoryOptions } from './access.ts';
import { admitMaintenanceRoot, MaintenanceRootRefused,
  type MaintenanceAdmission } from './maintenance-root.ts';

type Run = ReturnType<typeof memoryMaintenanceRecordedDataSchema.parse>;
type Binding = ReturnType<typeof memoryMaintenanceBoundDataSchema.parse>;
type Reason = 'binding_changed' | 'input_changed' | 'provider_unavailable' |
  'scope_occupied' | 'window_missed' | 'access_denied' | 'access_unavailable' |
  'budget_unavailable' | 'price_unavailable';

function digest(value: unknown): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

function savedReceipt(run: Run) {
  if (run.action === 'prepared') {
    return { outcome: 'prepared' as const, nightId: run.nightId, rootId: run.rootId,
      model: run.model, providerId: run.providerId,
      allowanceCents: run.acceptedCapCents, dispatch: 'disabled' as const };
  }
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
    return { intent: run, result: undefined, run };
  }
  const result = run.nightId === nightId && row.event.source === 'opencrane-server'
    ? run : undefined;
  return { intent, result, run };
}

function originalNight(rows: StoredEvent[], nightId: string) {
  let intent: Run | undefined;
  let binding: Binding | undefined;
  let result: Run | undefined;
  let changedBinding = false;
  let changedInput = false;
  const unresolvedNights = new Set<string>();
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
      if (next.run.nightId !== nightId) {
        if (next.run.action === 'due' || next.run.action === 'prepared' ||
            next.run.reason === 'qualification_blocked') {
          unresolvedNights.add(next.run.nightId);
        } else {
          unresolvedNights.delete(next.run.nightId);
        }
      }
      continue;
    }
    if (intent && ['memory.written', 'memory.corrected', 'memory.forgotten'].includes(
      row.event.type)) {
      changedInput = true;
    }
  }
  return { intent, binding, result, changedBinding, changedInput,
    occupied: unresolvedNights.size > 0 };
}

async function savedRoot(options: MemoryOptions, intent: Run) {
  // Check the accepted budget event before treating this delivery as a new admission.
  const rows = await history(options.store, `budget-${options.silo}`, options.silo,
    performance.now() + 10_000);
  for (const row of rows) {
    if (row.event.type !== 'budget.root_allowance_set') continue;
    const root = budgetRootAllowanceSetDataSchema.parse(row.event.data);
    const maintenance = root.maintenance;
    if (!maintenance || maintenance.scopeId !== intent.scopeId ||
        maintenance.nightId !== intent.nightId || maintenance.batchKey !== intent.batchKey ||
        maintenance.inputRevision !== intent.inputRevision ||
        root.requesterId !== intent.memberId ||
        root.allowanceCents !== intent.acceptedCapCents) {
      continue;
    }
    return { rootId: root.rootId, model: maintenance.model,
      providerId: maintenance.providerId };
  }
  return undefined;
}

async function recoverSavedRoot(options: MemoryOptions, rows: StoredEvent[],
  intent: Run, clock: () => Date) {
  let root: Awaited<ReturnType<typeof savedRoot>>;
  try {
    root = await savedRoot(options, intent);
  } catch {
    return { outcome: 'unknown' as const, nightId: intent.nightId,
      dispatch: 'disabled' as const };
  }
  if (!root) return undefined;
  const result = { action: 'prepared' as const, reason: null,
    rootId: root.rootId, model: root.model, providerId: root.providerId };
  return saveResult(options, rows, intent, result, clock);
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

async function saveResult(options: MemoryOptions, rows: StoredEvent[], intent: Run,
  outcome: Partial<Run>, clock: () => Date) {
  const time = clock().toISOString();
  const data = memoryMaintenanceRecordedDataSchema.parse({ ...intent, ...outcome,
    selectedAt: time });
  const id = digest([options.silo, intent.scopeId, intent.nightId, 'preflight']);
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

function saveRefusal(options: MemoryOptions, rows: StoredEvent[], intent: Run,
  reason: Reason, clock: () => Date) {
  const action = reason === 'window_missed' ? 'missed' as const : 'refused' as const;
  return saveResult(options, rows, intent, { action, reason }, clock);
}

function requireAssistant(binding: Binding | undefined) {
  if (!binding?.assistantId) throw new Error('Maintenance binding unavailable');
  return binding.assistantId;
}

export async function prepareNightlyMaintenance(options: MemoryOptions, scopeId: string,
  nightId: string, clock: () => Date = () => new Date(),
  admission?: MaintenanceAdmission) {
  // Read the growing scope history before any later short access check is added.
  const rows = await history(options.store, `scope-${scopeId}`, options.silo,
    performance.now() + 10_000);
  const state = originalNight(rows, nightId);
  const intent = state.intent;
  if (!intent || !validIntent(intent, scopeId, nightId)) {
    throw new Error('Maintenance night unavailable');
  }
  if (state.result) return savedReceipt(state.result);
  const recovered = await recoverSavedRoot(options, rows, intent, clock);
  if (recovered) return recovered;
  const reason = preflightReason(state, rows, intent, clock());
  if (reason) return saveRefusal(options, rows, intent, reason, clock);
  const assistantId = requireAssistant(state.binding);
  try {
    if (!await managedRouteAvailable(options, assistantId)) {
      return saveRefusal(options, rows, intent, 'provider_unavailable', clock);
    }
  } catch {
    return { outcome: 'unknown' as const, nightId, dispatch: 'disabled' as const };
  }
  if (!admission) {
    return { outcome: 'pending' as const, nightId, reason: 'qualification_blocked' as const,
      dispatch: 'disabled' as const };
  }
  try {
    const root = await admitMaintenanceRoot(options, intent, state.binding!,
      rows.at(-1)?.sequence ?? 0, admission);
    return saveResult(options, rows, intent, { action: 'prepared', reason: null,
      rootId: root.rootId, model: root.model, providerId: root.providerId }, clock);
  } catch (error) {
    if (error instanceof MaintenanceRootRefused) {
      return saveRefusal(options, rows, intent, error.reason, clock);
    }
    return { outcome: 'unknown' as const, nightId, dispatch: 'disabled' as const };
  }
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
