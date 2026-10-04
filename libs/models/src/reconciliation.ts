import { z } from 'zod';
import { effectResolvedDataSchema, effectObservedDataSchema, effectUncertainDataSchema } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { envelope, history } from './actor.ts';
import { losslessJson, type JsonValue } from './lossless-json.ts';
import { authorityFence } from './authority.ts';
import { applyBudget, data, emptyBudget } from './state.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
export const resolutionCommandSchema = z.object({ commandId: id, expectedSequence: z.int().nonnegative(),
  outcome: z.enum(['settled', 'released']), settledCents: z.int().nonnegative(),
  evidence: effectResolvedDataSchema.shape.evidence }).strict();

async function reservation(store: EventStore, silo: string, permitId: string) {
  const state = emptyBudget();
  for (const row of await history(store, `budget-${silo}`, silo)) applyBudget(state, row.event, row.sequence);
  return state.reservations.find(r => r.id === permitId);
}

/** Reads recorded evidence only. No provider call or external-action retry belongs here. */
export async function readEffect(store: EventStore, silo: string, permitId: string) {
  id.parse(permitId);
  const r = await reservation(store, silo, permitId);
  if (!r) return undefined;
  const rows = await history(store, `effect-${permitId}`, silo);
  const observed = rows.filter(row => row.event.type === 'effect.observed').map(row => ({
    eventId: row.event.id, ...effectObservedDataSchema.parse(row.event.data),
  }));
  const uncertain = rows.filter(row => row.event.type === 'effect.uncertain').map(row => effectUncertainDataSchema.parse(row.event.data));
  const resolutions = rows.filter(row => row.event.type === 'effect.resolved').map(row => effectResolvedDataSchema.parse(row.event.data));
  const resolution = resolutions.at(-1);
  const amounts = observed.map(o => o.costCents);
  const conflict = r.outcomeUnknown === true || new Set(amounts).size > 1 ||
    (resolution !== undefined && amounts.some(amount => amount !== resolution.settledCents));
  const state = conflict || (!resolution && r.settledCents === undefined) ? 'outcome_unknown' :
    r.settledCents === undefined ? 'resolution_pending' : resolution?.outcome === 'released' ? 'released' : 'settled';
  return { permitId, reservationId: r.id, reservedAt: r.time, reservedCents: r.amountCents,
    settledCents: r.settledCents ?? null, model: r.call.model, priceTableId: r.call.priceTableId,
    sequence: rows.at(-1)?.sequence ?? 0, state, label: { outcome_unknown: 'Outcome unknown', resolution_pending: 'Resolution pending', released: 'Released', settled: 'Settled' }[state],
    conflict, reasons: [...new Set(uncertain.map(e => e.reason))],
    observations: observed.map(o => ({ eventId: o.eventId, outcome: o.outcome, costCents: o.costCents, usage: o.usage })),
    resolution: resolution ? { outcome: resolution.outcome, settledCents: resolution.settledCents, evidence: resolution.evidence } : null };
}

export async function listEffects(store: EventStore, silo: string) {
  const ids = (await history(store, `budget-${silo}`, silo)).filter(r => r.event.type === 'budget.reserved')
    .map(r => z.string().parse(data(r.event)['permitId']));
  // ponytail: replay reservations for this admin read; index them when history makes this slow.
  return Promise.all(ids.map(permitId => readEffect(store, silo, permitId)));
}

/** The HTTP adapter supplies session identity; the command rechecks the event-backed role. */
export async function resolveEffect(store: EventStore, silo: string, permitId: string, memberId: string, raw: unknown,
  fresh?: () => Promise<void>) {
  id.parse(permitId);
  const command = resolutionCommandSchema.parse(resolutionInput(raw));
  const memberFresh = await authorityFence(store, performance.now(), [`member-${memberId}`]);
  const membership = await history(store, `member-${memberId}`, silo);
  const latest = membership.filter(r => ['member.joined', 'member.role_changed', 'member.removed'].includes(r.event.type)).at(-1);
  const member = latest ? data(latest.event) : {};
  if (latest?.event.type === 'member.removed' || !['owner', 'admin'].includes(String(member['newRole'] ?? member['role']))) throw new Error('Access changed');
  const current = await readEffect(store, silo, permitId);
  if (!current) return { status: 'not_found' } as const;
  const { commandId, expectedSequence, ...fields } = command;
  const payload = effectResolvedDataSchema.parse({ ...fields, permitId, reservationId: current.reservationId, resolvedBy: memberId });
  const rows = await history(store, `effect-${permitId}`, silo);
  const prior = rows.find(r => r.event.commandId === commandId);
  if (prior) return { status: JSON.stringify(prior.event.data) === JSON.stringify(payload) ? 'appended' : 'conflict' } as const;
  if (current.sequence !== expectedSequence || current.resolution || current.state !== 'outcome_unknown') return { status: 'conflict' } as const;
  if (!sufficient(payload) || current.observations.some(o => o.costCents !== payload.settledCents)) return { status: 'held' } as const;
  await fresh?.(); await memberFresh();
  return store.append({ event: { ...envelope(silo, `effect-${permitId}`, 'effect.resolved', payload, commandId),
    source: 'opencrane-server', principal: { kind: 'human', id: memberId } }, expectedSequence });
}

function sufficient(payload: z.infer<typeof effectResolvedDataSchema>) {
  return payload.outcome === 'released'
    ? payload.settledCents === 0 && payload.evidence.every(e => e.kind === 'dispatch_record')
    : payload.evidence.every(e => e.kind === 'provider_receipt' && e.amountCents === payload.settledCents);
}

function resolutionInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    const value = losslessJson(raw);
    if (!integerNumbers(value)) throw new Error('Integer required');
    return JSON.parse(value.canonical) as unknown;
  } catch { throw new Error('Invalid resolution JSON'); }
}
function integerNumbers(node: JsonValue): boolean {
  if (node.kind === 'number') return /^(?:0|[1-9]\d*)$/u.test(node.canonical) && Number.isSafeInteger(Number(node.canonical));
  if (node.value instanceof Map) return [...node.value.values()].every(integerNumbers);
  if (Array.isArray(node.value)) return node.value.every(integerNumbers);
  return true;
}
