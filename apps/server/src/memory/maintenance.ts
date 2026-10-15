import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import { authorityFence, history, readActiveMember } from '@opencrane/models';
import { memoryMaintenanceBoundDataSchema, memoryMaintenanceRecordedDataSchema,
  parseEventByType } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { selectMaintenanceInputs, type MaintenanceFact } from '@opencrane/projections';
import { memoryAccessChecks, scopeAccess, readAssistant, MemoryRefused,
  type MemoryOptions, type Scope } from './access.ts';
import { MemoryConflict, memorySnapshot } from './reads.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const bindingFields = memoryMaintenanceBoundDataSchema.pick({ assistantId: true,
  payingGroupId: true, enabled: true, acceptedCapCents: true });
const bindingInput = bindingFields.extend({
  commandId: identifier, expectedRevision: z.int().nonnegative() });
type BindingInput = z.infer<typeof bindingInput>;

export function bindingReceipt(row: StoredEvent) {
  const binding = memoryMaintenanceBoundDataSchema.parse(row.event.data);
  return { outcome: 'saved', binding, savedAt: row.event.time, dispatch: 'disabled' };
}

function nextNight(now: Date, savedAt: string | null): string {
  const after = Math.max(now.getTime(), Date.parse(savedAt ?? '1970-01-01T00:00:00Z'));
  const boundary = new Date(after);
  boundary.setUTCHours(2, 0, 0, 0);
  if (boundary.getTime() <= after) {
    boundary.setUTCDate(boundary.getUTCDate() + 1);
  }
  return boundary.toISOString();
}

type FactRow = { memory_id: string; revision: string; expires_at: string | null;
  pinned: boolean; position: string; content_status: string; ciphertext: string };

function maintenanceFact(row: FactRow): MaintenanceFact {
  return { memoryId: row.memory_id, revision: Number(row.revision),
    expiresAt: row.expires_at, pinned: row.pinned, position: Number(row.position),
    status: row.content_status, encryptedBytes: Buffer.from(row.ciphertext, 'base64').byteLength };
}

type MaintenanceRun = ReturnType<typeof memoryMaintenanceRecordedDataSchema.parse>;

async function factChangeStatus(options: MemoryOptions, scope: Scope, position: number,
  runs: MaintenanceRun[], savedAt: string | null) {
  const facts = await options.db.query<FactRow>(`SELECT memory_id, revision, expires_at,
    pinned, position, content_status, ciphertext FROM memory_facts
    WHERE silo=$1 AND scope_id=$2 AND position<=$3`,
  [options.silo, scope.scopeId, position]);
  const changes = await options.db.query<{ position: string; outcome: string }>(
    `SELECT position, outcome FROM memory_changes
     WHERE silo=$1 AND scope_id=$2 AND position<=$3`,
    [options.silo, scope.scopeId, position]);
  let lastChangePosition = 0;
  let lastForgetPosition = 0;
  for (const change of changes.rows) {
    const changePosition = Number(change.position);
    lastChangePosition = Math.max(lastChangePosition, changePosition);
    if (change.outcome === 'forgotten') {
      lastForgetPosition = Math.max(lastForgetPosition, changePosition);
    }
  }
  const factMetadata = facts.rows.map(maintenanceFact);
  const now = new Date();
  const selection = selectMaintenanceInputs(factMetadata, runs,
    lastChangePosition, lastForgetPosition, now.toISOString());
  const status = selection.dirty ? 'qualification_blocked' : 'clean';
  const nextAt = selection.dirty ? nextNight(now, savedAt) : null;
  return { status, nextAt, waitingCount: selection.waitingCount };
}

export async function maintenanceStatus(options: MemoryOptions, scope: Scope, requester: string) {
  const snapshot = await memorySnapshot(options, scope);
  const result = await options.db.query<{ data: unknown; saved_at: string | null }>(
    `SELECT binding.data, binding.saved_at
    FROM projection_checkpoints checkpoint JOIN projection_generations generation USING (name)
    LEFT JOIN memory_maintenance_bindings binding ON binding.silo=$1 AND binding.scope_id=$2
    WHERE checkpoint.name='memory' AND checkpoint.sequence >= $3 AND generation.generation=$4`,
  [options.silo, scope.scopeId, snapshot.position, snapshot.generation]);
  if (!result.rows[0]) {
    throw new Error('Memory maintenance status unavailable');
  }
  let binding = null;
  let status = 'not_configured';
  if (result.rows[0].data !== null) {
    binding = memoryMaintenanceBoundDataSchema.parse(result.rows[0].data);
    if (binding.memberId !== requester) {
      throw new MemoryRefused();
    }
    status = 'disabled';
  }
  const runs = await options.db.query<{ data: unknown }>(
    `SELECT run.data FROM projection_checkpoints checkpoint
     JOIN projection_generations generation USING (name)
     LEFT JOIN LATERAL (SELECT data FROM memory_maintenance_runs
       WHERE silo=$1 AND scope_id=$2 AND position<=$3 ORDER BY position DESC) run ON true
     WHERE checkpoint.name='memory' AND checkpoint.sequence >= $3 AND generation.generation=$4`,
    [options.silo, scope.scopeId, snapshot.position, snapshot.generation]);
  if (!runs.rows.length) {
    throw new Error('Memory maintenance history unavailable');
  }
  const allRuns = [];
  for (const row of runs.rows) {
    if (row.data !== null) {
      allRuns.push(memoryMaintenanceRecordedDataSchema.parse(row.data));
    }
  }
  let waitingCount = 0;
  let nextAt: string | null = null;
  if (binding?.enabled) {
    const state = await factChangeStatus(options, scope, snapshot.position,
      allRuns, result.rows[0].saved_at);
    status = state.status;
    nextAt = state.nextAt;
    waitingCount = state.waitingCount;
  }
  const history = [];
  const empty = { status, binding, dispatch: 'disabled', nextAt, waitingCount, history: [] };
  const encodedEmpty = JSON.stringify(empty);
  let bytes = Buffer.byteLength(encodedEmpty);
  for (const run of allRuns) {
    if (history.length === 20) {
      break;
    }
    const encodedRun = JSON.stringify(run);
    bytes += Buffer.byteLength(encodedRun) + 1;
    if (bytes > 16_384) {
      break;
    }
    history.push(run);
  }
  return { status, binding, dispatch: 'disabled', nextAt, waitingCount, history };
}

function requireMatchingScope(scope: Scope, input: BindingInput,
  assistant: Awaited<ReturnType<typeof readAssistant>>['assistant']) {
  if (scope.scopeKind === 'group' &&
      (assistant.kind !== 'team' || assistant.ownerId !== scope.ownerId)) {
    throw new MemoryRefused();
  }
  if (scope.scopeKind === 'assistant_notes' && input.assistantId !== scope.ownerId) {
    throw new MemoryRefused();
  }
  if (assistant.payingGroupId && assistant.payingGroupId !== input.payingGroupId) {
    throw new MemoryRefused();
  }
}

async function requireCompatibleAssistant(options: MemoryOptions, requester: string,
  scope: Scope, input: BindingInput, checks: ReturnType<typeof memoryAccessChecks>) {
  checks.watch(`assistant-${input.assistantId}`);
  const { created, assistant } = await readAssistant(options, input.assistantId);
  if (!await checks.applied(created.id)) {
    throw new Error('Assistant permissions unavailable');
  }
  if (assistant.kind === 'team') {
    await checks.group(assistant.ownerId);
  } else if (assistant.ownerId !== requester) {
    throw new MemoryRefused();
  }
  requireMatchingScope(scope, input, assistant);
  const auth = memberAuthorisation(options.binding);
  const permission = await auth.actsFor(requester, input.assistantId);
  if (permission.status === 'unavailable') {
    throw new Error('Assistant permissions unavailable');
  }
  if (!permission.allowed) {
    throw new MemoryRefused();
  }
  await checks.group(input.payingGroupId);
}

function bindingHistory(rows: StoredEvent[], requester: string, input: BindingInput) {
  let revision = 0;
  for (const row of rows) {
    const original = row.event.commandId === input.commandId &&
      row.event.principal?.kind === 'human' && row.event.principal.id === requester;
    if (original && row.event.type !== 'memory.maintenance_bound') {
      throw new MemoryConflict();
    }
    if (row.event.type !== 'memory.maintenance_bound') {
      continue;
    }
    const binding = memoryMaintenanceBoundDataSchema.parse(row.event.data);
    revision = binding.revision;
    if (original) {
      const originalInput = { assistantId: binding.assistantId, payingGroupId: binding.payingGroupId,
        enabled: binding.enabled, acceptedCapCents: binding.acceptedCapCents,
        commandId: input.commandId, expectedRevision: binding.revision - 1 };
      const checkedOriginal = bindingInput.parse(originalInput);
      const originalCommand = JSON.stringify(checkedOriginal);
      const requestedCommand = JSON.stringify(input);
      if (originalCommand !== requestedCommand) {
        throw new MemoryConflict();
      }
      return { revision, original: row };
    }
  }
  return { revision, original: undefined };
}

export async function bindMaintenance(options: MemoryOptions, requester: string,
  scope: Scope, value: unknown) {
  const input = bindingInput.parse(value);
  // Read content history before starting the short check of who may write.
  const rows = await history(options.store, `scope-${scope.scopeId}`, options.silo,
    performance.now() + 10_000);
  const fresh = await authorityFence(options.store, performance.now(), [`member-${requester}`]);
  const checks = memoryAccessChecks(options, requester, fresh);
  await readActiveMember(options.store, options.binding, requester, 'member', checks.applied);
  const access = await scopeAccess(options, requester, scope, true, checks);
  if (!access.canRead || !access.canWrite) {
    throw new MemoryRefused();
  }
  if (input.enabled) {
    await requireCompatibleAssistant(options, requester, scope, input, checks);
  }
  const state = bindingHistory(rows, requester, input);
  if (state.original) {
    await fresh();
    return bindingReceipt(state.original);
  }
  if (state.revision !== input.expectedRevision) {
    throw new MemoryConflict();
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify([options.silo, requester, scope.scopeId, input.commandId]));
  const data = { ...scope, memberId: requester, assistantId: input.assistantId,
    payingGroupId: input.payingGroupId, enabled: input.enabled,
    acceptedCapCents: input.acceptedCapCents, revision: state.revision + 1 };
  const event = { id: hash.digest('hex'), type: 'memory.maintenance_bound',
    source: 'opencrane-server', subject: `scope-${scope.scopeId}`, silo: options.silo,
    time: new Date().toISOString(), commandId: input.commandId,
    principal: { kind: 'human' as const, id: requester }, correlation: {}, data };
  if (!parseEventByType(event).success) {
    throw new Error('Invalid binding event');
  }
  await fresh();
  const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0,
    historyChecked: true as const, deadline: fresh.deadline };
  let result;
  try {
    result = await options.store.append(command);
  } catch {
    return { outcome: 'unknown', dispatch: 'disabled' };
  }
  if (result.status === 'unavailable') {
    return { outcome: 'unknown', dispatch: 'disabled' };
  }
  if (result.status !== 'appended') {
    throw new MemoryConflict();
  }
  return bindingReceipt({ event, sequence: result.sequence });
}
