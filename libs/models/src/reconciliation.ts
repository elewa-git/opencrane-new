import { currentEffectState } from './current-effects.ts';
import { currentMembership } from './ownership.ts';
import { z } from 'zod';
import { effectResolvedDataSchema, effectObservedDataSchema, effectUncertainDataSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { envelope, history } from './actor.ts';
import { losslessJson, type JsonValue } from '@opencrane/events/lossless-json';
import { authorityFence } from './authority.ts';
import { applyBudget, emptyBudget, type BudgetState } from './state.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
export const resolutionCommandSchema = z.object({ commandId: id, expectedSequence: z.int().nonnegative(),
  outcome: z.enum(['settled', 'released']), settledCents: z.int().nonnegative(),
  evidence: effectResolvedDataSchema.shape.evidence }).strict();

const resolutionReceiptSchema = z.object({
  changeRef: id, eventId: id, position: z.int().positive(), time: z.iso.datetime(),
  resolvedBy: id, outcome: z.enum(['settled', 'released']), settledCents: z.int().nonnegative(),
}).strict();

/** Read the saved resolution only; it does not prove settlement or external success. */
export async function readEffectChange(store: EventStore, silo: string, permitId: string,
  changeRef: string) {
  id.parse(permitId);
  id.parse(changeRef);
  const deadline = performance.now() + 10_000;
  const subject = `effect-${permitId}`;
  const rows = await history(store, subject, silo, deadline);
  if (performance.now() >= deadline) throw new Error('Effect read expired');
  return savedResolutionReceipt(rows, silo, permitId, changeRef);
}

function savedResolutionReceipt(rows: StoredEvent[], silo: string, permitId: string,
  changeRef: string) {
  function matchesChange(row: StoredEvent) {
    return row.event.commandId === changeRef;
  }
  const matches = rows.filter(matchesChange);
  if (!matches.length) return undefined;
  // Refuse ambiguous or untrusted records instead of confirming another caller's result.
  const saved = matches[0]!;
  const event = saved.event;
  if (matches.length !== 1 || event.type !== 'effect.resolved' ||
      event.silo !== silo || event.subject !== `effect-${permitId}` ||
      event.source !== 'opencrane-server' || event.principal?.kind !== 'human') {
    throw new Error('Invalid resolution receipt');
  }
  const data = effectResolvedDataSchema.parse(event.data);
  if (data.permitId !== permitId || data.reservationId !== permitId ||
      data.resolvedBy !== event.principal.id) {
    throw new Error('Invalid resolution receipt');
  }
  const receipt = { changeRef, eventId: event.id, position: saved.sequence, time: event.time,
    resolvedBy: data.resolvedBy, outcome: data.outcome, settledCents: data.settledCents };
  return resolutionReceiptSchema.parse(receipt);
}

function originalResolutionReceipt(rows: StoredEvent[], silo: string, permitId: string) {
  function isResolution(row: StoredEvent) {
    return row.event.type === 'effect.resolved';
  }
  const resolutions = rows.filter(isResolution);
  if (resolutions.length === 0) return null;
  // Require one saved resolution; a later equal amount cannot identify the original operator.
  if (resolutions.length !== 1) throw new Error('Invalid resolution receipt');
  const changeRef = id.parse(resolutions[0]!.event.commandId);
  return savedResolutionReceipt(rows, silo, permitId, changeRef);
}

async function reservation(store: EventStore, silo: string, permitId: string, deadline: number) {
  const state = emptyBudget();
  const rows = await history(store, `budget-${silo}`, silo, deadline);
  for (const row of rows) {
    applyBudget(state, row.event, row.sequence);
  }
  function matchesPermit(held: BudgetState['reservations'][number]) {
    return held.id === permitId;
  }
  const held = state.reservations.find(matchesPermit);
  return { held, state, sequence: state.sequence };
}

async function applyNewBudgetEvents(store: EventStore, silo: string, state: BudgetState,
  seen: number, deadline: number) {
  const rows = store.readStream(`budget-${silo}`, seen + 1, deadline);
  for await (const row of rows) {
    if (row.event.silo !== silo) {
      throw new Error('Wrong silo');
    }
    applyBudget(state, row.event, row.sequence);
  }
}

/** Reads recorded evidence only. No provider call or external-action retry belongs here. */
export async function readEffect(store: EventStore, silo: string, permitId: string) {
  id.parse(permitId);
  const deadline = performance.now() + 10_000;
  const records = await effectRecords(store, silo, permitId, deadline);
  if (!records) return undefined;
  const resolutionReceipt = originalResolutionReceipt(records.rows, silo, permitId);
  return { ...records.current, resolutionReceipt };
}

async function effectRecords(store: EventStore, silo: string, permitId: string, deadline: number) {
  const { held, state, sequence } = await reservation(store, silo, permitId, deadline);
  if (!held) return undefined;
  const rows = await history(store, `effect-${permitId}`, silo, deadline);
  if (performance.now() >= deadline) throw new Error('Effect read expired');
  return { current: effectStatus(held, rows), rows, held, budget: state, budgetSequence: sequence };
}

function effectStatus(r: BudgetState['reservations'][number], rows: StoredEvent[]) {
  const permitId = r.id;
  const observed = rows.filter(row => row.event.type === 'effect.observed').map(row => ({
    eventId: row.event.id, ...effectObservedDataSchema.parse(row.event.data),
  }));
  const uncertain = rows.filter(row => row.event.type === 'effect.uncertain').map(row => effectUncertainDataSchema.parse(row.event.data));
  const resolutions = rows.filter(row => row.event.type === 'effect.resolved').map(row => effectResolvedDataSchema.parse(row.event.data));
  const resolution = resolutions.at(-1);
  const amounts = observed.map(o => o.costCents);
  const { state, conflict } = currentEffectState(r.outcomeUnknown === true,
    r.settledCents ?? null, amounts, resolution);
  return { permitId, reservationId: r.id, reservedAt: r.time, reservedCents: r.amountCents,
    settledCents: r.settledCents ?? null, model: r.call.model, priceTableId: r.call.priceTableId,
    sequence: rows.at(-1)?.sequence ?? 0, state, label: { outcome_unknown: 'Outcome unknown', resolution_pending: 'Resolution pending', released: 'Released', settled: 'Settled' }[state],
    conflict, reasons: [...new Set(uncertain.map(e => e.reason))],
    observations: observed.map(o => ({ eventId: o.eventId, outcome: o.outcome, costCents: o.costCents, usage: o.usage })),
    resolution: resolution ? { outcome: resolution.outcome, settledCents: resolution.settledCents, evidence: resolution.evidence } : null };
}

export async function listEffects(store: EventStore, silo: string) {
  const deadline = performance.now() + 10_000;
  const budget = emptyBudget();
  const budgetRows = await history(store, `budget-${silo}`, silo, deadline);
  for (const row of budgetRows) {
    applyBudget(budget, row.event, row.sequence);
  }
  const effects = [];
  // Keep every reservation, including old holds whose outcome is still unknown.
  for (const reservation of budget.reservations) {
    const rows = await history(store, `effect-${reservation.id}`, silo, deadline);
    effects.push(effectStatus(reservation, rows));
  }
  if (performance.now() >= deadline) {
    throw new Error('Effect read expired');
  }
  return effects;
}

/** The HTTP adapter supplies session identity; the command rechecks the event-backed role. */
export async function resolveEffect(store: EventStore, silo: string, permitId: string, memberId: string, raw: unknown,
  fresh?: () => Promise<void>) {
  id.parse(permitId);
  const command = resolutionCommandSchema.parse(resolutionInput(raw));
  const deadline = performance.now() + 10_000;
  const records = await effectRecords(store, silo, permitId, deadline);
  // Start HTTP access checks after history; call them again immediately before saving.
  await fresh?.();
  const memberFresh = await authorityFence(store, performance.now(), [`member-${memberId}`]);
  const membership = await currentMembership(store, silo, memberId, memberFresh);
  if (!['owner', 'admin'].includes(membership.role)) {
    throw new Error('Access changed');
  }
  if (!records) return { status: 'not_found' } as const;
  const { rows, held, budget, budgetSequence } = records;
  let current = records.current;
  // Check for releases saved during history before deciding whether the hold can be resolved.
  const budgetHead = await store.head(`budget-${silo}`, memberFresh.deadline);
  if (budgetHead !== budgetSequence) {
    await applyNewBudgetEvents(store, silo, budget, budgetSequence, memberFresh.deadline);
    current = effectStatus(held, rows);
  }
  const { commandId, expectedSequence, ...fields } = command;
  const payload = effectResolvedDataSchema.parse({ ...fields, permitId, reservationId: current.reservationId, resolvedBy: memberId });
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
