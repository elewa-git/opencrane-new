import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { budgetCeilingSetDataSchema } from '@opencrane/events';
import { budgetCommandSchema } from '@opencrane/protocol';
import { history } from './event-history.ts';
import { readBudgetResource } from './budget-resource.ts';
import { MemberAccessRefused } from './member-authority.ts';

export class BudgetAccessRefused extends Error {}
export class BudgetChoiceRefused extends Error {}

function budgetRefusal(error: unknown) {
  if (error instanceof BudgetChoiceRefused) {
    return { statusCode: 422,
      body: { status: 'refused', reason: 'spending_choice_unavailable' } };
  }
  let statusCode = 503;
  if (error instanceof BudgetAccessRefused) {
    statusCode = 403;
  } else if (error instanceof z.ZodError) {
    statusCode = 400;
  }
  return { statusCode, body: { status: 'refused' } };
}

export function respondBudgetRefusal(response: ServerResponse, error: unknown) {
  const refusal = budgetRefusal(error);
  response.writeHead(refusal.statusCode);
  response.end(JSON.stringify(refusal.body));
}

export async function budgetScope(store: EventStore, silo: string, raw: unknown) {
  const command = budgetCommandSchema.parse(raw);
  const deadline = performance.now() + 10_000;
  const positions = new Map<string, number>();
  async function checkResource(kind: 'paying_group' | 'assistant', id: string) {
    const choice = await readBudgetResource(store, silo, kind, id, deadline, positions);
    if (!choice) throw new MemberAccessRefused('Spending choice unavailable');
  }
  async function checkPayer(groupId: string) {
    if (groupId === 'installation-default') {
      const savedDefault = await savedDefaultPayer(store, silo, deadline);
      if (savedDefault === groupId) return;
    }
    await checkResource('paying_group', groupId);
  }
  if (command.scope === 'paying_group') {
    await checkPayer(command.scopeId);
  }
  if (command.scope === 'assistant') {
    await checkResource('assistant', command.scopeId);
  }
  if (command.scope === 'global' && command.defaultPayingGroupId !== undefined) {
    await checkPayer(command.defaultPayingGroupId);
  }
  return positions;
}


async function savedDefaultPayer(store: EventStore, silo: string, deadline: number) {
  const subject = `budget-${silo}`;
  const rows = await history(store, subject, silo, deadline);
  let defaultPayer: string | undefined;
  for (const { event } of rows) {
    if (event.subject !== subject) {
      throw new MemberAccessRefused('Spending choice unavailable');
    }
    if (event.type !== 'budget.ceiling_set') continue;
    const ceiling = budgetCeilingSetDataSchema.parse(event.data);
    if (ceiling.scope === 'global' && ceiling.defaultPayingGroupId !== undefined) {
      defaultPayer = ceiling.defaultPayingGroupId;
    }
  }
  // Accept only the installation payer already recorded by startup or migration.
  return defaultPayer;
}
