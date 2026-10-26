import { expect } from 'vitest';
import type { natsFixture } from '@opencrane/event-store/testing';
import type { Query } from '@opencrane/projections';
import { BudgetActor, envelope, priceTableId, readSpendingCalls,
  readCurrentEffects } from '@opencrane/models';

type Nats = Awaited<ReturnType<typeof natsFixture>>;

export async function seedRecoveryBudgets(nats: Nats) {
  function now() { return new Date('2026-10-26T12:00:00.000Z'); }
  const team = envelope('test', 'team-sales', 'team.created',
    { teamId: 'sales', name: 'Sales', createdBy: 'alice' });
  const assistant = envelope('test', 'assistant-sales-assistant', 'assistant.created',
    { assistantId: 'sales-assistant', ownerId: 'sales', kind: 'team', payingGroupId: 'sales' });
  await nats.seed([team, assistant]);
  const actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(20_000, 20_000, 'sales');
  const call = { model: 'gpt-6-luna', priceTableId, payingGroupId: 'sales',
    assistantId: 'sales-assistant', computerId: 'computer', requesterId: 'alice',
    conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
    contextDigest: '0'.repeat(64) };
  const held = await actor.reserve(call, 120);
  const settled = await actor.reserve(call, 100);
  const unresolved = await actor.reserve(call, 90);
  const evidence = [{ kind: 'provider_receipt', reference: 'fixture-receipt',
    digest: '0'.repeat(64), amountCents: 70 }];
  const resolution = envelope('test', `effect-${settled}`, 'effect.resolved',
    { reservationId: settled, permitId: settled, settledCents: 70,
      outcome: 'settled', resolvedBy: 'owner', evidence });
  const saved = { ...resolution, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: 'owner' } };
  await nats.seed([saved]);
  await actor.settleRecorded(settled, saved.id);
  const uncertain = envelope('test', `effect-${unresolved}`, 'effect.uncertain',
    { permitId: unresolved, computerId: 'computer', reason: 'missing_usage' });
  await nats.seed([uncertain]);
  return { held, settled, unresolved };
}

export async function expectRecoveryMoney(db: Query, sequence: number,
  ids: Awaited<ReturnType<typeof seedRecoveryBudgets>>) {
  const calls = await readSpendingCalls(db, 'test');
  expect(calls.rows).toMatchObject([
    { reservationId: ids.held, permitId: ids.held, heldCents: 120, settledCents: null },
    { reservationId: ids.settled, permitId: ids.settled, heldCents: 0, settledCents: 70 },
    { reservationId: ids.unresolved, permitId: ids.unresolved, heldCents: 90, settledCents: null },
  ]);
  expect(calls.rows).toHaveLength(3);
  let heldCents = 0;
  let settledCents = 0;
  for (const row of calls.rows) {
    heldCents += row.heldCents;
    settledCents += row.settledCents ?? 0;
  }
  expect({ heldCents, settledCents }).toEqual({ heldCents: 210, settledCents: 70 });
  const current = await readCurrentEffects(db, 'test', sequence);
  expect(current.rows).toHaveLength(3);
  expect(current.rows).toMatchObject([
    { permitId: ids.held, heldCents: 120, settledCents: null, state: 'outcome_unknown' },
    { permitId: ids.settled, heldCents: 0, settledCents: 70, state: 'settled' },
    { permitId: ids.unresolved, heldCents: 90, settledCents: null, state: 'outcome_unknown' },
  ]);
}
