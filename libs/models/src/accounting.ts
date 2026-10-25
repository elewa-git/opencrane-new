import { z } from 'zod';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { Projection, Query } from '@opencrane/projections';
import { applyBudget, data, emptyBudget, stateSchema, totals, type BudgetState } from './state.ts';
import { createCurrentEffects, currentEffectFields, currentEffectSchema,
  currentEffectBudget, updateCurrentEffectEvidence } from './current-effects.ts';

export const budgetProjectionVersion = 6;
type Reservation = BudgetState['reservations'][number];
const pageSchema = z.object({
  after: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(50).default(20),
  payingGroupId: z.string().min(1).optional(),
  assistantId: z.string().min(1).optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).optional(),
}).strict();
const callSchema = z.object({
  silo: z.string(), reservationId: z.string(), permitId: z.string(),
  position: z.coerce.number().int().nonnegative(),
  payingGroupId: z.string().nullable(), assistantId: z.string().nullable(),
  reservedAt: z.string(), heldCents: z.coerce.number().int().nonnegative(),
  settledCents: z.coerce.number().int().nonnegative().nullable(),
  evidence: z.enum(['held', 'settled', 'unknown', 'not_dispatched']),
});
export type SpendingCall = z.infer<typeof callSchema> & { day: string; month: string };

const effectPageSchema = pageSchema.pick({ after: true, limit: true }).extend({
  permitId: z.string().min(1).optional(),
});
const effectSchema = z.object({
  silo: z.string(), eventId: z.string(), permitId: z.string(),
  position: z.coerce.number().int().positive(), time: z.iso.datetime({ offset: true }),
  type: z.enum(['effect.observed', 'effect.uncertain', 'effect.resolved']),
  outcome: z.enum(['success', 'error', 'settled', 'released']).nullable(),
  costCents: z.coerce.number().int().nonnegative().nullable(),
  settledCents: z.coerce.number().int().nonnegative().nullable(),
  resolvedBy: z.string().nullable(), changeRef: z.string().nullable(),
});
async function createBudgetEffects(db: Query, table: string) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    silo TEXT NOT NULL, event_id TEXT NOT NULL, permit_id TEXT NOT NULL,
    position BIGINT NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL, outcome TEXT,
    cost_cents BIGINT, settled_cents BIGINT, resolved_by TEXT, change_ref TEXT,
    PRIMARY KEY (silo, event_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_position ON ${table} (silo, position)`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_permit
    ON ${table} (silo, permit_id, position)`);
}
async function saveBudgetEffect(db: Query, table: string, event: EventEnvelope, position: number) {
  if (!parseEventByType(event).success) throw new Error('Invalid effect event');
  const payload = data(event);
  const permitId = z.string().parse(payload['permitId']);
  let resolvedBy: string | null = null;
  let changeRef: string | null = null;
  // Confirm the same server and human binding used by saved resolution receipts.
  if (event.type === 'effect.resolved' && event.source === 'opencrane-server' &&
      event.subject === `effect-${permitId}` && payload['reservationId'] === permitId &&
      event.principal?.kind === 'human' && payload['resolvedBy'] === event.principal.id) {
    resolvedBy = event.principal.id;
    changeRef = event.commandId ?? null;
  }
  const row = effectSchema.parse({ silo: event.silo, eventId: event.id, permitId, position,
    time: event.time, type: event.type, outcome: payload['outcome'] ?? null,
    costCents: payload['costCents'] ?? null, settledCents: payload['settledCents'] ?? null,
    resolvedBy, changeRef });
  // Keep conflicting observations as separate records; redelivery keeps the original position.
  await db.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (silo, event_id) DO NOTHING`, [row.silo, row.eventId, row.permitId,
    row.position, row.time, row.type, row.outcome, row.costCents, row.settledCents,
    row.resolvedBy, row.changeRef]);
}
function spendingEffect(row: Record<string, unknown>) {
  return effectSchema.parse(row);
}

/** Read saved records only. Callers must check finance access after loading, including failures. */
export async function readSpendingEffects(db: Query, silo: string,
  input: z.input<typeof effectPageSchema> = {}, deadline = performance.now() + 2000) {
  const page = effectPageSchema.parse(input);
  const options = { deadline };
  const progress = await db.query<{ version: number; sequence: string; generation: string }>(
    `SELECT version, sequence, generation FROM projection_versions
      JOIN projection_checkpoints USING (name) JOIN projection_generations USING (name)
      WHERE name = $1`, ['model-budgets'], options);
  const saved = progress.rows[0];
  if (!saved || saved.version < budgetProjectionVersion) {
    throw new Error('Spending effects unavailable');
  }
  const conditions = ['silo = $1', 'position > $2'];
  const parameters: unknown[] = [silo, page.after];
  if (page.permitId !== undefined) {
    parameters.push(page.permitId);
    conditions.push(`permit_id = $${parameters.length}`);
  }
  parameters.push(page.limit + 1);
  const result = await db.query(`SELECT silo, event_id AS "eventId", permit_id AS "permitId",
    position, time, type, outcome, cost_cents AS "costCents", settled_cents AS "settledCents",
    resolved_by AS "resolvedBy", change_ref AS "changeRef" FROM model_budget_effects
    WHERE ${conditions.join(' AND ')} ORDER BY position LIMIT $${parameters.length}`,
  parameters, options);
  const selected = result.rows.slice(0, page.limit);
  const rows = selected.map(spendingEffect);
  let next: number | null = null;
  if (result.rows.length > page.limit) next = rows.at(-1)!.position;
  return { rows, next, sequence: Number(saved.sequence), generation: Number(saved.generation) };
}

async function createBudgetCalls(db: Query, table: string) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    silo TEXT NOT NULL, reservation_id TEXT NOT NULL, permit_id TEXT NOT NULL,
    position BIGINT NOT NULL, paying_group_id TEXT, assistant_id TEXT,
    reserved_at TEXT NOT NULL, held_cents BIGINT NOT NULL, settled_cents BIGINT,
    evidence TEXT NOT NULL, PRIMARY KEY (silo, reservation_id))`);
  for (const [suffix, columns] of [
    ['position', 'silo, position'],
    ['payer', 'silo, paying_group_id, position'],
    ['assistant', 'silo, assistant_id, position'],
    ['scopes', 'silo, paying_group_id, assistant_id, position'],
    ['month', 'silo, left(reserved_at, 7), position'],
    ['month_payer', 'silo, left(reserved_at, 7), paying_group_id, position'],
    ['month_assistant', 'silo, left(reserved_at, 7), assistant_id, position'],
    ['month_scopes', 'silo, left(reserved_at, 7), paying_group_id, assistant_id, position'],
  ]) {
    await db.query(`CREATE INDEX IF NOT EXISTS ${table}_${suffix} ON ${table} (${columns})`);
  }
}
function evidenceFor(reservation: Reservation): SpendingCall['evidence'] {
  if (reservation.outcomeUnknown) return 'unknown';
  if (reservation.outcome === 'not_dispatched') return 'not_dispatched';
  if (reservation.settledCents !== undefined) return 'settled';
  return 'held';
}
async function saveBudgetCall(db: Query, table: string, silo: string, position: number,
  permitId: string, reservation: Reservation, heldCents: number) {
  const evidence = evidenceFor(reservation);
  // Preserve the reservation's original position and attribution on later settlement.
  await db.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (silo, reservation_id) DO UPDATE SET
      held_cents = $8, settled_cents = $9, evidence = $10`,
  [silo, reservation.id, permitId, position, reservation.call.payingGroupId ?? null,
    reservation.call.assistantId, reservation.time, heldCents,
    reservation.settledCents ?? null, evidence]);
}
function spendingCall(input: Record<string, unknown>): SpendingCall {
  const row = callSchema.parse(input);
  return { ...row, day: row.reservedAt.slice(0, 10), month: row.reservedAt.slice(0, 7) };
}

/** Read internal accounting only. Callers must check current finance access after loading. */
export async function readSpendingCalls(db: Query, silo: string,
  input: z.input<typeof pageSchema> = {}, deadline = performance.now() + 2000) {
  const page = pageSchema.parse(input);
  const options = { deadline };
  const progress = await db.query<{ version: number; sequence: string; generation: string }>(
    `SELECT version, sequence, generation FROM projection_versions
      JOIN projection_checkpoints USING (name) JOIN projection_generations USING (name)
      WHERE name = $1`, ['model-budgets'], options);
  const saved = progress.rows[0];
  if (!saved || saved.version < budgetProjectionVersion) {
    throw new Error('Spending calls unavailable');
  }
  const conditions = ['silo = $1', 'position > $2'];
  const parameters: unknown[] = [silo, page.after];
  if (page.payingGroupId !== undefined) {
    parameters.push(page.payingGroupId);
    conditions.push(`paying_group_id = $${parameters.length}`);
  }
  if (page.assistantId !== undefined) {
    parameters.push(page.assistantId);
    conditions.push(`assistant_id = $${parameters.length}`);
  }
  if (page.month !== undefined) {
    parameters.push(page.month);
    conditions.push(`left(reserved_at, 7) = $${parameters.length}`);
  }
  parameters.push(page.limit + 1);
  const result = await db.query(`SELECT silo, reservation_id AS "reservationId",
    permit_id AS "permitId", position, paying_group_id AS "payingGroupId",
    assistant_id AS "assistantId", reserved_at AS "reservedAt", held_cents AS "heldCents",
    settled_cents AS "settledCents", evidence FROM model_budget_calls
    WHERE ${conditions.join(' AND ')} ORDER BY position LIMIT $${parameters.length}`,
  parameters, options);
  const selected = result.rows.slice(0, page.limit);
  const rows = selected.map(spendingCall);
  let next: number | null = null;
  if (result.rows.length > page.limit) next = rows.at(-1)!.position;
  return { rows, next, sequence: Number(saved.sequence), generation: Number(saved.generation) };
}

async function saveBudgetState(db: Query, table: string, currentTable: string,
  silo: string, state: BudgetState, current: ReturnType<typeof currentEffectBudget> | undefined) {
  const savedState = JSON.stringify(state);
  if (!current) {
    await db.query(`INSERT INTO ${table} VALUES ($1, $2)
      ON CONFLICT (silo) DO UPDATE SET state = $2`, [silo, savedState]);
    return;
  }
  // Save both validated records in one round trip; keep all money rules in TypeScript.
  await db.query(`WITH saved_budget AS (
    INSERT INTO ${table} VALUES ($1, $2)
    ON CONFLICT (silo) DO UPDATE SET state = $2
  ) INSERT INTO ${currentTable} VALUES ($1, $3, $4, $5)
    ON CONFLICT (silo, permit_id) DO UPDATE SET position = $4, data = $5`,
  [silo, savedState, current.permitId, current.position, JSON.stringify(current)]);
}

// Keep call reads separate while retaining the existing budget summary fold.
function budgetProjection(name: string, table: string): Projection {
  const callsTable = table.replace('model_budgets', 'model_budget_calls');
  const effectsTable = table.replace('model_budgets', 'model_budget_effects');
  const currentTable = table.replace('model_budgets', 'model_current_effects');
  async function create(db: Query) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${table}
      (silo TEXT PRIMARY KEY, state JSONB NOT NULL)`);
    await createBudgetCalls(db, callsTable);
    await createBudgetEffects(db, effectsTable);
    await createCurrentEffects(db, currentTable);
  }
  async function drop(db: Query) {
    await db.query(`DROP TABLE IF EXISTS ${table}, ${callsTable}, ${effectsTable}, ${currentTable}`);
  }
  async function apply(db: Query, event: EventEnvelope,
    position: number) {
    if (event.type === 'effect.observed' || event.type === 'effect.uncertain' ||
        event.type === 'effect.resolved') {
      await saveBudgetEffect(db, effectsTable, event, position);
      await updateCurrentEffectEvidence(db, currentTable, event, position);
      return;
    }
    if (!event.type.startsWith('budget.')) return;
    if (!parseEventByType(event).success) throw new Error('Invalid budget event');
    const payload = data(event);
    const rows = await db.query<{ state: unknown; current: unknown;
      budgetSilo: string | null; effectPermitId: string | null }>(
      `SELECT budget.state, budget.silo AS "budgetSilo", effect.data AS current,
        effect.permit_id AS "effectPermitId" FROM (SELECT $1::text AS silo) requested
        LEFT JOIN ${table} budget ON budget.silo = requested.silo
        LEFT JOIN ${currentTable} effect
          ON effect.silo = requested.silo AND effect.permit_id = $2`,
    [event.silo, payload['reservationId'] ?? null]);
    const saved = rows.rows[0]!;
    const state = saved.budgetSilo === null ? emptyBudget() : stateSchema.parse(saved.state);
    applyBudget(state, event, position);
    let current: ReturnType<typeof currentEffectBudget> | undefined;
    if (event.type === 'budget.reserved' || event.type === 'budget.settled') {
      function matches(reservation: BudgetState['reservations'][number]) {
        return reservation.id === payload['reservationId'];
      }
      const reservation = state.reservations.find(matches)!;
      const singleCall = { ...state, reservations: [reservation] };
      const heldCents = totals(singleCall).reservedCents;
      const permitId = z.string().parse(payload['permitId']);
      await saveBudgetCall(db, callsTable, event.silo, position, permitId, reservation, heldCents);
      const previous = saved.effectPermitId === null ? undefined : saved.current;
      current = currentEffectBudget(previous, event.silo, position, reservation, heldCents);
    }
    await saveBudgetState(db, table, currentTable, event.silo, state, current);
  }
  return { name, create, drop, apply };
}
export const budgets = budgetProjection('model-budgets', 'model_budgets');
export const replayBudgets = budgetProjection('model-budgets-replay', 'model_budgets_replay');

const currentPageSchema = pageSchema.pick({ after: true, limit: true });
async function currentEffectProgress(db: Query, sequence: number, deadline: number) {
  const result = await db.query<{ version: number; sequence: string; generation: string }>(
    `SELECT version, sequence, generation FROM projection_versions
      JOIN projection_checkpoints USING (name) JOIN projection_generations USING (name)
      WHERE name = $1`, [budgets.name], { deadline });
  const saved = result.rows[0];
  if (!saved || saved.version < budgetProjectionVersion || Number(saved.sequence) < sequence) {
    throw new Error('Current effects unavailable');
  }
  return { sequence: Number(saved.sequence), generation: Number(saved.generation) };
}
function currentEffect(row: Record<string, unknown>) {
  return currentEffectSchema.parse(row);
}
/** Capture the required log position first; check finance access after loading, even on failure. */
export async function readCurrentEffects(db: Query, silo: string, requiredSequence: number,
  input: z.input<typeof currentPageSchema> = {}, deadline = performance.now() + 2000) {
  z.int().nonnegative().parse(requiredSequence);
  const page = currentPageSchema.parse(input);
  const progress = await currentEffectProgress(db, requiredSequence, deadline);
  const result = await db.query(`SELECT ${currentEffectFields} FROM model_current_effects
    WHERE silo = $1 AND position > $2 ORDER BY position LIMIT $3`,
  [silo, page.after, page.limit + 1], { deadline });
  const selected = result.rows.slice(0, page.limit);
  const rows = selected.map(currentEffect);
  const after = await currentEffectProgress(db, requiredSequence, deadline);
  if (progress.generation !== after.generation) {
    throw new Error('Current effects unavailable');
  }
  let next: number | null = null;
  if (result.rows.length > page.limit) next = rows.at(-1)!.position;
  return { rows, next, ...progress };
}
