import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { expect } from 'vitest';
import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { BudgetActor } from '@opencrane/models';
import { shortDuplicateWindowFixture } from './duplicate-window.ts';
import { routineAsk } from './routine-ask.ts';

export function example(type: string) {
  return z.record(z.string(), z.unknown()).parse(getEventDefinition(type)!.example);
}
export async function expiryFixture() {
  const nats = await shortDuplicateWindowFixture();
  let clock = new Date('2026-10-11T07:00:00.000Z');
  function now() { return clock; }
  function advance(milliseconds: number) {
    clock = new Date(Date.parse('2026-10-11T07:00:00Z') + milliseconds);
  }
  async function save(type: string, subject: string, data: unknown,
    changes: Partial<EventEnvelope> = {}) {
    const id = randomUUID();
    const event: EventEnvelope = { id, commandId: id, silo: 'test', subject, type, data,
      source: 'models', principal: { kind: 'system', id: 'models' },
      time: now().toISOString(), correlation: {}, ...changes };
    const result = await nats.store.append({ event,
      expectedSequence: await nats.store.head(subject) });
    expect(result.status).toBe('appended');
    return { eventId: event.id, position: await nats.store.head(subject) };
  }
  const owner = { source: 'opencrane-server', principal: { kind: 'human' as const, id: 'alice' } };
  const system = { source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' } };
  await save('routine.created', 'routine-orders',
    { ...example('routine.created'), status: 'active' }, owner);
  const run = { ...example('routine.due'), conversationId: 'routine-session-occurrence',
    turnId: 'routine-turn-occurrence' };
  const claim = await save('routine.due', 'routine-orders', run, system);
  const conversationId = 'routine-session-occurrence';
  const turnId = 'routine-turn-occurrence';
  const creationId = 'routine-session-create-occurrence';
  const creation = { ...owner, id: creationId, commandId: creationId };
  await save('conversation.created', `conversation-${conversationId}`,
    { conversationId, assistantId: 'sales-assistant', createdBy: 'alice',
      payingGroupId: 'sales', mode: 'agent_session', routinePreparation: {
        routineId: 'orders', occurrenceId: 'occurrence', claimId: claim.eventId,
        claimPosition: claim.position, workerId: 'worker' } }, creation);
  const actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(10_000, 10_000, 'sales');
  const binding = { requesterId: 'alice', conversationId, turnId, threadId: 'thread',
    assistantId: 'sales-assistant', computerId: 'computer', generation: 1,
    payingGroupId: 'sales', allowanceCents: 1000, preparationDigest: '0'.repeat(64) };
  const allocation = await actor.setRootAllowance(binding, 1);
  const allocationRow = await nats.store.readEvent(await nats.store.head('budget-test'));
  const admission = { eventId: allocationRow.event.id, position: allocationRow.sequence };
  await save('routine.run_activation_admitted', 'routine-orders',
    { ...example('routine.run_activation_admitted'), conversationId, turnId, admission }, system);
  await save('agent.turn_started', `conversation-${conversationId}`,
    { conversationId, turnId, assistantId: 'sales-assistant' });
  const checkedAt = Date.now();
  const digest = createHash('sha256').update('[]').digest('hex');
  await save('mcp.server_discovered', 'mcp-mcp_1', { serverId: 'mcp_1', toolCount: 0,
    schemaDigest: digest, checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(checkedAt + 300_000).toISOString(), connectionId: 'installed', accountMode: 'none', tools: [] });
  const policy = await save('mcp.server_published', 'mcp-mcp_1',
    { serverId: 'mcp_1', publishedBy: 'alice' });
  const request = await routineAsk(nats.store, 'Requested', { policySequence: policy.position });
  const input = { routineId: 'orders', occurrenceId: 'occurrence', request };
  async function decision(decision = 'approved') {
    return save('approval.decided', 'approval-ask-Requested',
      { approvalId: 'ask-Requested', decidedBy: 'alice', decision }, owner);
  }
  async function use(evidence?: string) {
    await decision();
    const permitId = '00000000-0000-4000-8000-000000000001';
    await save('approval.used', 'approval-ask-Requested',
      { approvalId: 'ask-Requested', permitId });
    if (evidence) {
      await save('tool.dispatch_recorded', `decision-${permitId}`,
        { ...example('tool.dispatch_recorded'), requestId: permitId,
          approvalId: 'ask-Requested', conversationId, turnId, serverId: 'mcp_1',
          toolName: 'odoo.write', outcome: 'not_dispatched', evidence });
    }
  }
  return { nats, now, advance, save, input, decision, use, actor, binding,
    rootId: allocation.rootId };
}
