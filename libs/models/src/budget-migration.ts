import { randomUUID } from 'node:crypto';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { applyBudget, emptyBudget } from './state.ts';
import { history } from './event-history.ts';
import { z } from 'zod';

export function envelope(silo: string, subject: string, type: string, payload: unknown,
  id: string = randomUUID(), now = new Date()): EventEnvelope {
  const parsed = parseEventByType({ id, commandId: id, type, subject, silo, data: payload,
    source: 'models', time: now.toISOString(), principal: { kind: 'system', id: 'models' } });
  if (!parsed.success) throw new Error('Invalid model event');
  return parsed.event;
}

/** Run with budget writers stopped or under the leadership lease; each migration appends once. */
export async function migrateBudgetDefault(store: EventStore, silo: string,
  defaultPayingGroupId: string) {
  z.string().min(1).parse(defaultPayingGroupId);
  const rows = await history(store, `budget-${silo}`, silo);
  if (!rows.length) return; // Fresh installations are seeded by the actor.
  const state = emptyBudget();
  for (const row of rows) applyBudget(state, row.event, row.sequence);
  if (state.defaultPayingGroupId) return;
  const event = envelope(silo, `budget-${silo}`, 'budget.ceiling_set', { scope: 'global',
    dailyCeilingCents: state.dailyCeilingCents, ceilingCents: state.ceilingCents,
    defaultPayingGroupId, setBy: 'installation' });
  const result = await store.append({ event, expectedSequence: rows.at(-1)!.sequence });
  if (result.status !== 'appended') {
    throw new Error('Budget default migration append failed; retry with writers stopped');
  }
}
