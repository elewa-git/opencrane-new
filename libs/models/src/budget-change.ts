import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { budgetCeilingSetDataSchema } from '@opencrane/events';
import { history } from './event-history.ts';
import { readActiveMember, MemberAccessRefused } from './member-authority.ts';
import { applyBudget, emptyBudget } from './state.ts';
import { ceilingReceipt } from './ceiling-command.ts';

export async function budgetChange(store: EventStore, binding: Binding,
  memberId: string, commandId: string) {
  const subject = `budget-${binding.silo}`;
  let rows: StoredEvent[] | undefined;
  try {
    rows = await history(store, subject, binding.silo, performance.now() + 10_000);
  } catch {
    // Keep an incomplete read unknown; it cannot prove that a command was not saved.
  }
  function matchesCommand(row: StoredEvent) {
    return row.event.type === 'budget.ceiling_set' && row.event.subject === subject &&
      row.event.commandId === commandId;
  }
  const saved = rows?.find(matchesCommand);
  const role = await readActiveMember(store, binding, memberId);
  if (role !== 'owner' && role !== 'admin') {
    if (!saved) throw new MemberAccessRefused('Owner or Admin required');
    const payload = budgetCeilingSetDataSchema.parse(saved.event.data);
    if (payload.setBy !== memberId) throw new MemberAccessRefused('Owner or Admin required');
    return { status: 'appended', commandId };
  }
  const authorisation = memberAuthorisation(binding);
  const permission = await authorisation.check(memberId, 'admin');
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) throw new MemberAccessRefused('Owner or Admin required');
  if (!saved || !rows) return { status: 'unknown' };
  const state = emptyBudget();
  for (const row of rows) applyBudget(state, row.event, row.sequence);
  return ceilingReceipt(saved, state);
}
