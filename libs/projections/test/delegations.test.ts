import { expect, it } from 'vitest';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { budgets, readBudget, totals } from '@opencrane/models';
import { delegations, ProjectionRunner } from '../src/index.ts';
import { database } from './database.ts';

async function rebuildsTasksWithoutEffects() {
  const nats = await natsFixture();
  const storage = await database('pg');
  let position = 0;
  const sequences = new Map<string, number>();
  async function append(type: string, subject: string, data: unknown) {
    position++;
    const event = { id: `event-${position}`, commandId: `command-${position}`, type, subject,
      data, silo: 'test', source: 'opencrane-server', time: '2026-10-10T10:00:00Z',
      principal: { kind: 'system', id: 'opencrane-server' } };
    const parsed = parseEventByType(event);
    if (!parsed.success) throw new Error('Invalid delegation fixture');
    const result = await nats.store.append({ event: parsed.event,
      expectedSequence: sequences.get(subject) ?? 0 });
    expect(result.status).toBe('appended');
    if (result.status === 'appended') sequences.set(subject, result.sequence);
    return { eventId: event.id, position };
  }
  async function rows() {
    const tasks = await storage.db.query('SELECT * FROM delegations ORDER BY delegation_id');
    const turns = await storage.db.query('SELECT * FROM computer_delegations ORDER BY turn_id');
    return { tasks: tasks.rows, turns: turns.rows };
  }
  try {
    const definition = getEventDefinition('delegation.started');
    const parsed = schemaExample(definition?.example);
    const child = { ...parsed, delegationId: 'child', turnId: 'child-turn',
      threadId: 'child-thread', parentDelegationId: undefined };
    const native = { ...child, task: 'native_descendant' };
    delete native['version'];
    delete native['computerAdmission'];
    const admission = await append('computer.turn_started', 'computer-assistant', native);
    const start = { ...child, computerAdmission: admission };
    await append('delegation.started', 'delegation-child', start);
    const grandchild = { ...start, delegationId: 'grandchild', turnId: 'grandchild-turn',
      threadId: 'grandchild-thread', parentDelegationId: 'child', parentTurnId: 'child-turn',
      parentThreadId: 'child-thread' };
    await append('delegation.started', 'delegation-grandchild', grandchild);
    const closed = { ...native, status: 'cancelled' };
    const terminalEvidence = await append('computer.turn_closed', 'computer-assistant', closed);
    const outcome = { version: 1, delegationId: 'child', outcome: 'cancelled',
      reason: 'root_stopped', terminalEvidence };
    await append('delegation.completed', 'delegation-child', outcome);
    await append('delegation.completed', 'delegation-child', { ...outcome, outcome: 'completed' });
    const legacy = { delegationId: 'legacy', parentComputerId: 'old-parent',
      childComputerId: 'old-child', rootBudgetId: 'old-budget' };
    await append('delegation.started', 'delegation-legacy', legacy);
    const modelCall = { model: 'gpt-6-luna', priceTableId: 'tariff',
      computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
      conversationId: 'chat', turnId: 'root-turn', threadId: 'root-thread',
      contextDigest: 'a'.repeat(64) };
    for (const [reservationId, amountCents] of [['settled', 240], ['held', 110]] as const) {
      const reservation = { reservationId, permitId: reservationId, amountCents,
        payingGroupId: 'sales', assistantId: 'assistant', modelCall };
      await append('budget.reserved', 'budget-test', reservation);
    }
    const settlement = { reservationId: 'settled', permitId: 'settled', settledCents: 240 };
    await append('budget.settled', 'budget-test', settlement);
    const logger = createLogger('delegations-test', { level: 'silent' });
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(delegations);
    await runner.initialise(budgets);
    await runner.run(delegations);
    await runner.run(budgets);
    const originalBudget = await readBudget(storage.db, 'test');
    expect(totals(originalBudget, new Date('2026-10-10'))).toMatchObject({
      todayCents: 240, monthCents: 240, reservedCents: 110 });
    const original = await rows();
    expect(original.tasks).toHaveLength(3);
    expect(original.tasks[0]).toMatchObject({ root_id: 'root', parent_delegation_id: null,
      outcome: outcome, start_position: '2', outcome_position: '5' });
    expect(original.tasks[1]).toMatchObject({ root_id: 'root', parent_delegation_id: 'child' });
    expect(original.tasks[2]).toMatchObject({ root_id: null, start: legacy });
    expect(original.turns).toHaveLength(1);
    expect(original.turns[0]).toMatchObject({ root_id: 'root', status: 'cancelled' });
    await runner.rebuild(delegations);
    await runner.rebuild(budgets);
    await runner.run(delegations);
    expect(await rows()).toEqual(original);
    expect(await readBudget(storage.db, 'test')).toEqual(originalBudget);
    expect(await nats.reader.head()).toBe(position);
  } finally {
    await storage.close();
    await nats.close();
  }
}
function schemaExample(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Missing modern example');
  return { ...value };
}
it('rebuilds hierarchy and frozen outcomes without spawning or granting legacy authority',
  rebuildsTasksWithoutEffects);
