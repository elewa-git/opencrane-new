import { z } from 'zod';
import type { EventEnvelope } from '@opencrane/events';
import type { Query } from '@opencrane/projections';
import { data, type BudgetState } from './state.ts';

type Resolution = { outcome: 'settled' | 'released'; settledCents: number };
export function currentEffectState(outcomeUnknown: boolean, settledCents: number | null,
  amounts: number[], resolution: Resolution | undefined) {
  let conflict = outcomeUnknown;
  for (const amount of amounts) {
    if (amount !== amounts[0] || (resolution && amount !== resolution.settledCents)) {
      conflict = true;
    }
  }
  let state: 'outcome_unknown' | 'resolution_pending' | 'released' | 'settled';
  if (conflict || (!resolution && settledCents === null)) {
    state = 'outcome_unknown';
  } else if (settledCents === null) {
    state = 'resolution_pending';
  } else if (resolution?.outcome === 'released') {
    state = 'released';
  } else {
    state = 'settled';
  }
  return { state, conflict };
}

export const currentEffectSchema = z.object({
  silo: z.string(), permitId: z.string(), position: z.coerce.number().int().nonnegative(),
  payingGroupId: z.string().nullable(), assistantId: z.string().nullable(), reservedAt: z.string(),
  heldCents: z.int().nonnegative(), settledCents: z.int().nonnegative().nullable(),
  state: z.enum(['outcome_unknown', 'resolution_pending', 'released', 'settled']),
  conflict: z.boolean(), budgetPosition: z.int().nonnegative(), effectPosition: z.int().nonnegative(),
});
const storedSchema = currentEffectSchema.extend({
  amounts: z.array(z.int().nonnegative()).max(2), outcomeUnknown: z.boolean(),
  resolution: z.object({ outcome: z.enum(['settled', 'released']),
    settledCents: z.int().nonnegative() }).optional(),
});
type CurrentEffect = z.infer<typeof storedSchema>;
export const currentEffectFields = `silo, permit_id AS "permitId", position,
  data->'payingGroupId' AS "payingGroupId", data->'assistantId' AS "assistantId",
  data->'reservedAt' AS "reservedAt", data->'heldCents' AS "heldCents",
  data->'settledCents' AS "settledCents", data->'state' AS state, data->'conflict' AS conflict,
  data->'budgetPosition' AS "budgetPosition", data->'effectPosition' AS "effectPosition"`;

export async function createCurrentEffects(db: Query, table: string) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    silo TEXT NOT NULL, permit_id TEXT NOT NULL, position BIGINT NOT NULL,
    data JSONB NOT NULL, PRIMARY KEY (silo, permit_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_position ON ${table} (silo, position)`);
}
async function loadCurrentEffect(db: Query, table: string, silo: string, permitId: string) {
  const result = await db.query<{ data: unknown }>(
    `SELECT data FROM ${table} WHERE silo = $1 AND permit_id = $2`, [silo, permitId]);
  return currentEffect(result.rows[0]?.data, silo, permitId);
}
function currentEffect(saved: unknown, silo: string, permitId: string) {
  if (saved !== undefined) {
    return storedSchema.parse(saved);
  }
  // Keep early evidence until its reservation arrives; position zero is never listed.
  const initial = { silo, permitId, position: 0, payingGroupId: null,
    assistantId: null, reservedAt: '', heldCents: 0, settledCents: null,
    state: 'outcome_unknown', conflict: false, budgetPosition: 0, effectPosition: 0,
    amounts: [], outcomeUnknown: false };
  return storedSchema.parse(initial);
}
function checkedCurrentEffect(row: CurrentEffect) {
  const status = currentEffectState(row.outcomeUnknown, row.settledCents,
    row.amounts, row.resolution);
  const updated = { ...row, ...status };
  return storedSchema.parse(updated);
}
async function saveCurrentEffect(db: Query, table: string, row: CurrentEffect) {
  const saved = checkedCurrentEffect(row);
  await db.query(`INSERT INTO ${table} VALUES ($1, $2, $3, $4)
    ON CONFLICT (silo, permit_id) DO UPDATE SET position = $3, data = $4`,
  [row.silo, row.permitId, row.position, JSON.stringify(saved)]);
}
export function currentEffectBudget(saved: unknown, silo: string,
  position: number, reservation: BudgetState['reservations'][number], heldCents: number) {
  const row = currentEffect(saved, silo, reservation.id);
  if (position <= row.budgetPosition) {
    return undefined;
  }
  if (row.position === 0) {
    row.position = position;
    row.payingGroupId = reservation.call.payingGroupId ?? null;
    row.assistantId = reservation.call.assistantId;
    row.reservedAt = reservation.time;
  }
  row.heldCents = heldCents;
  row.settledCents = reservation.settledCents ?? null;
  row.outcomeUnknown = reservation.outcomeUnknown === true;
  row.budgetPosition = position;
  return checkedCurrentEffect(row);
}
export async function updateCurrentEffectEvidence(db: Query, table: string,
  event: EventEnvelope, position: number) {
  // Match the stream read by readEffect, rather than trusting a payload's permit reference.
  if (!event.subject.startsWith('effect-')) {
    return;
  }
  const permitId = event.subject.slice('effect-'.length);
  const row = await loadCurrentEffect(db, table, event.silo, permitId);
  if (position <= row.effectPosition) {
    return;
  }
  const payload = data(event);
  if (event.type === 'effect.observed') {
    const amount = z.int().nonnegative().parse(payload['costCents']);
    const amounts = [...row.amounts, amount];
    // Retain only the extremes needed to detect conflicts, regardless of history size.
    row.amounts = [Math.min(...amounts), Math.max(...amounts)];
  } else if (event.type === 'effect.resolved') {
    row.resolution = storedSchema.shape.resolution.parse(payload);
  }
  row.effectPosition = position;
  await saveCurrentEffect(db, table, row);
}
