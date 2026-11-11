import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import { authorityFence, history, readActiveMember } from '@opencrane/models';
import { memoryMaintenanceBoundDataSchema, memoryMaintenanceRecordedDataSchema,
  budgetRootAllowanceSetDataSchema, parseEventByType } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { selectMaintenanceInputs, type MaintenanceFact } from '@opencrane/projections';
import { memoryAccessChecks, scopeAccess, readAssistant, MemoryRefused,
  type MemoryOptions, type Scope } from './access.ts';
import { MemoryConflict, memorySnapshot, pageCursor, readCursor } from './reads.ts';

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
type SavedRun = { event_id: string; data: unknown; saved_at: string | null;
  position: string };

function positionMask(secret: string): bigint {
  const hash = createHmac('sha256', secret);
  hash.update('memory-run-position');
  const digest = hash.digest();
  return digest.readBigUInt64BE();
}

function runReference(secret: string, row: SavedRun): string {
  // Keep older deterministic night ids out of URLs and responses.
  const hiddenPosition = BigInt(row.position) ^ positionMask(secret);
  const positionHex = hiddenPosition.toString(16);
  const positionPart = positionHex.padStart(16, '0');
  const hash = createHmac('sha256', secret);
  hash.update(`memory-run:${row.event_id}`);
  const digest = hash.digest('hex');
  const referenceDigest = digest.slice(0, 48);
  return `${positionPart}${referenceDigest}`;
}

function runPosition(secret: string, runId: string): string {
  const hiddenPosition = BigInt(`0x${runId.slice(0, 16)}`);
  const position = hiddenPosition ^ positionMask(secret);
  if (position < 1n || position > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MemoryRefused();
  }
  return position.toString();
}

function safeRun(secret: string, row: SavedRun) {
  const run = memoryMaintenanceRecordedDataSchema.parse(row.data);
  return { runId: runReference(secret, row), action: run.action, reason: run.reason,
    intendedAt: run.intendedAt, selectedAt: run.selectedAt, observedAt: row.saved_at,
    money: { status: 'unavailable' } };
}

const moneyRow = z.object({
  version: z.number().int(), sequence: z.coerce.number().int().nonnegative().safe(),
  rootPosition: z.coerce.number().int().positive().safe().nullable(),
  rootData: z.unknown().nullable(), reservationId: z.string().nullable(),
  permitId: z.string().nullable(), callPosition: z.coerce.number().int().positive().safe().nullable(),
  payingGroupId: z.string().nullable(), assistantId: z.string().nullable(),
  heldCents: z.coerce.number().int().nonnegative().safe().nullable(),
  settledCents: z.coerce.number().int().nonnegative().safe().nullable(),
  evidence: z.enum(['held', 'settled', 'unknown', 'not_dispatched']).nullable(),
});
type MoneyRow = z.infer<typeof moneyRow>;

function hasCurrentBudget(row: MoneyRow, budgetPosition: number, receiptPosition: number) {
  return row.version >= 7 && row.sequence >= budgetPosition &&
    row.rootPosition !== null && row.rootPosition <= receiptPosition &&
    row.rootPosition <= row.sequence &&
    row.callPosition !== null && row.callPosition >= row.rootPosition &&
    row.callPosition <= row.sequence;
}

function matchesSavedRoot(row: MoneyRow, run: MaintenanceRun) {
  const parsed = budgetRootAllowanceSetDataSchema.safeParse(row.rootData);
  if (!parsed.success) return false;
  const root = parsed.data;
  const maintenance = root.maintenance;
  if (!maintenance) return false;
  const matchesRun = root.rootId === run.rootId && root.requesterId === run.memberId &&
    root.allowanceCents === run.acceptedCapCents &&
    maintenance.scopeId === run.scopeId && maintenance.nightId === run.nightId &&
    maintenance.batchKey === run.batchKey &&
    maintenance.inputRevision === run.inputRevision &&
    maintenance.model === run.model && maintenance.providerId === run.providerId;
  const matchesCall = row.payingGroupId === root.payingGroupId &&
    row.assistantId === root.assistantId;
  return matchesRun && matchesCall;
}

function hasConsistentCall(row: MoneyRow) {
  if (row.reservationId === null || row.permitId === null ||
      row.heldCents === null || row.evidence === null) return false;
  if (row.evidence === 'held') return row.settledCents === null;
  if (row.evidence === 'settled') {
    return row.settledCents !== null && row.heldCents === 0;
  }
  if (row.evidence === 'not_dispatched') {
    return row.settledCents === 0 && row.heldCents === 0;
  }
  return row.heldCents > 0;
}

async function maintenanceMoney(options: MemoryOptions, run: MaintenanceRun,
  receiptPosition: number, deadline: number) {
  const unavailable = { status: 'unavailable' as const };
  if (run.action !== 'prepared' || !run.rootId) return unavailable;
  const moneyDeadline = Math.min(deadline - 300, performance.now() + 750);
  if (moneyDeadline <= performance.now()) return unavailable;
  try {
    const budgetPosition = await options.store.head(`budget-${options.silo}`, moneyDeadline);
    const result = await options.db.query(`SELECT version.version, progress.sequence,
        root.position AS "rootPosition", root.data AS "rootData",
        call.reservation_id AS "reservationId", call.permit_id AS "permitId",
        call.position AS "callPosition", call.paying_group_id AS "payingGroupId",
        call.assistant_id AS "assistantId", call.held_cents AS "heldCents",
        call.settled_cents AS "settledCents", call.evidence
      FROM projection_versions version
      JOIN projection_checkpoints progress ON progress.name = version.name
      JOIN projection_generations generation ON generation.name = version.name
      LEFT JOIN model_budget_roots root ON root.silo=$1 AND root.root_id=$2
      LEFT JOIN LATERAL (SELECT reservation_id, permit_id, position, paying_group_id,
        assistant_id, held_cents, settled_cents, evidence FROM model_budget_calls
        WHERE silo=$1 AND root_id=$2 LIMIT 2) call ON true
      WHERE version.name='model-budgets'`,
    [options.silo, run.rootId], { deadline: moneyDeadline });
    if (result.rows.length !== 1) return unavailable;
    const parsed = moneyRow.safeParse(result.rows[0]);
    if (!parsed.success) return unavailable;
    const row = parsed.data;
    if (!hasCurrentBudget(row, budgetPosition, receiptPosition) || !matchesSavedRoot(row, run) ||
        !hasConsistentCall(row)) return unavailable;
    const spentCents = row.settledCents ?? 0;
    return { status: 'current' as const, spentCents,
      heldCents: row.heldCents, evidence: row.evidence };
  } catch {
    return unavailable;
  }
}

function cursorBinding(options: MemoryOptions, scope: Scope, requester: string,
  snapshot: Awaited<ReturnType<typeof memorySnapshot>>) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['maintenance', options.silo, scope.scopeId, requester,
    snapshot.position, snapshot.generation]));
  return hash.digest('hex');
}

async function confirmSnapshot(options: MemoryOptions, scope: Scope,
  saved: Awaited<ReturnType<typeof memorySnapshot>>, deadline: number) {
  const current = await memorySnapshot(options, scope, deadline);
  if (current.position !== saved.position || current.generation !== saved.generation) {
    throw new Error('Memory maintenance read table changed');
  }
}

function historyPage(secret: string, binding: string, rows: SavedRun[],
  status: object) {
  const history: ReturnType<typeof safeRun>[] = [];
  let lastPosition = 0;
  for (let index = 0; index < rows.length; index++) {
    if (history.length === 20) {
      break;
    }
    const row = rows[index]!;
    const next = safeRun(secret, row);
    const position = Number(row.position);
    const trial = { ...status, history: [...history, next],
      nextCursor: pageCursor(secret, binding, position, new Date(0)) };
    if (Buffer.byteLength(JSON.stringify(trial)) > 16_384) {
      break;
    }
    history.push(next);
    lastPosition = position;
  }
  if (history.length === 0 && rows.length > 0) {
    throw new Error('Memory maintenance page unavailable');
  }
  let nextCursor: string | null = null;
  if (history.length < rows.length) {
    nextCursor = pageCursor(secret, binding, lastPosition, new Date(0));
  }
  return { ...status, history, nextCursor };
}

function visibleMaintenanceStatus(run: MaintenanceRun | undefined,
  calculated: string): string {
  if (run?.action === 'prepared') {
    return 'preparing';
  }
  if (run?.action === 'refused' && run.reason !== 'qualification_blocked') {
    return 'refused';
  }
  return calculated;
}

async function factChangeStatus(options: MemoryOptions, scope: Scope, position: number,
  runs: MaintenanceRun[], savedAt: string | null, deadline: number) {
  const facts = await options.db.query<FactRow>(`SELECT memory_id, revision, expires_at,
    pinned, position, content_status, ciphertext FROM memory_facts
    WHERE silo=$1 AND scope_id=$2 AND position<=$3`,
  [options.silo, scope.scopeId, position], { deadline });
  const changes = await options.db.query<{ position: string; outcome: string }>(
    `SELECT position, outcome FROM memory_changes
     WHERE silo=$1 AND scope_id=$2 AND position<=$3`,
    [options.silo, scope.scopeId, position], { deadline });
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

export async function maintenanceStatus(options: MemoryOptions, scope: Scope, requester: string,
  secret: string, deadline = performance.now() + 10_000, cursor?: string) {
  const snapshot = await memorySnapshot(options, scope, deadline);
  const result = await options.db.query<{ data: unknown; saved_at: string | null }>(
    `SELECT binding.data, binding.saved_at
    FROM projection_checkpoints checkpoint JOIN projection_generations generation USING (name)
    LEFT JOIN memory_maintenance_bindings binding ON binding.silo=$1 AND binding.scope_id=$2
    WHERE checkpoint.name='memory' AND checkpoint.sequence >= $3 AND generation.generation=$4`,
  [options.silo, scope.scopeId, snapshot.position, snapshot.generation], { deadline });
  if (!result.rows[0]) {
    throw new Error('Memory maintenance status unavailable');
  }
  let binding = null;
  let status = 'not_configured';
  if (result.rows[0].data !== null) {
    binding = memoryMaintenanceBoundDataSchema.parse(result.rows[0].data);
    if (scope.scopeKind === 'person' && binding.memberId !== requester) {
      throw new MemoryRefused();
    }
    status = 'disabled';
  }
  const bindingValue = cursorBinding(options, scope, requester, snapshot);
  const { offset } = readCursor(secret, bindingValue, cursor);
  const beforePosition = cursor ? offset : snapshot.position + 1;
  const runs = await options.db.query<SavedRun>(
    `SELECT run.event_id, run.data, run.saved_at, run.position
     FROM projection_checkpoints checkpoint
     JOIN projection_generations generation USING (name)
     LEFT JOIN LATERAL (SELECT event_id, data, saved_at, position
       FROM memory_maintenance_runs WHERE silo=$1 AND scope_id=$2
         AND position<=$3 AND position<$5 ORDER BY position DESC LIMIT 21) run ON true
     WHERE checkpoint.name='memory' AND checkpoint.sequence >= $3
       AND generation.generation=$4`,
    [options.silo, scope.scopeId, snapshot.position, snapshot.generation, beforePosition],
    { deadline });
  if (!runs.rows.length) {
    throw new Error('Memory maintenance history unavailable');
  }
  const reviews = await options.db.query<{ data: unknown }>(
    `SELECT review.data FROM memory_facts fact
     JOIN memory_maintenance_reviews review
       ON review.silo=fact.silo AND review.scope_id=fact.scope_id
       AND review.memory_id=fact.memory_id AND review.revision=fact.revision
       AND review.fact_position=fact.position
     WHERE fact.silo=$1 AND fact.scope_id=$2
     UNION ALL
     SELECT data FROM memory_maintenance_reviews
     WHERE silo=$1 AND scope_id=$2 AND memory_id=''`,
    [options.silo, scope.scopeId], { deadline });
  const reviewedRuns: MaintenanceRun[] = [];
  for (const row of reviews.rows) {
    reviewedRuns.push(memoryMaintenanceRecordedDataSchema.parse(row.data));
  }
  const latest = await options.db.query<{ data: unknown }>(
    `SELECT data FROM memory_maintenance_runs
     WHERE silo=$1 AND scope_id=$2 AND position<=$3
     ORDER BY position DESC LIMIT 1`,
    [options.silo, scope.scopeId, snapshot.position], { deadline });
  const latestRun = latest.rows[0]
    ? memoryMaintenanceRecordedDataSchema.parse(latest.rows[0].data) : undefined;
  let waitingCount = 0;
  let nextAt: string | null = null;
  if (binding?.enabled) {
    const state = await factChangeStatus(options, scope, snapshot.position,
      reviewedRuns, result.rows[0].saved_at, deadline);
    status = state.status;
    nextAt = state.nextAt;
    waitingCount = state.waitingCount;
    status = visibleMaintenanceStatus(latestRun, status);
  }
  function saved(row: SavedRun) {
    return row.data !== null;
  }
  const savedRuns = runs.rows.filter(saved);
  const visible = { status, binding, dispatch: 'disabled', nextAt, waitingCount };
  const page = historyPage(secret, bindingValue, savedRuns, visible);
  await confirmSnapshot(options, scope, snapshot, deadline);
  return page;
}

export async function maintenanceDetail(options: MemoryOptions, scope: Scope,
  runId: string, secret: string, deadline = performance.now() + 10_000) {
  const snapshot = await memorySnapshot(options, scope, deadline);
  const position = runPosition(secret, runId);
  const result = await options.db.query<SavedRun>(
    `SELECT run.event_id, run.data, run.saved_at, run.position
     FROM projection_checkpoints checkpoint
     JOIN projection_generations generation USING (name)
     LEFT JOIN LATERAL (SELECT event_id, data, saved_at, position
       FROM memory_maintenance_runs WHERE silo=$1 AND scope_id=$2
         AND position<=$3 AND position=$5 LIMIT 1) run ON true
     WHERE checkpoint.name='memory' AND checkpoint.sequence >= $3
       AND generation.generation=$4`,
    [options.silo, scope.scopeId, snapshot.position, snapshot.generation, position],
    { deadline });
  if (!result.rows.length) {
    throw new Error('Memory maintenance detail unavailable');
  }
  let detail: ReturnType<typeof safeRun> & { bindingRevision: number;
    memberId: string; rootId: string | null; allowanceCents: number | null;
    startedAt: null } | undefined;
  for (const row of result.rows) {
    if (row.data === null || runReference(secret, row) !== runId) {
      continue;
    }
    const run = memoryMaintenanceRecordedDataSchema.parse(row.data);
    const allowanceCents = run.action === 'prepared' ? run.acceptedCapCents : null;
    const money = await maintenanceMoney(options, run, Number(row.position), deadline);
    detail = { ...safeRun(secret, row), money, bindingRevision: run.bindingRevision,
      memberId: run.memberId, rootId: run.rootId ?? null, allowanceCents,
      startedAt: null };
  }
  await confirmSnapshot(options, scope, snapshot, deadline);
  if (!detail) {
    throw new MemoryRefused();
  }
  return detail;
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
