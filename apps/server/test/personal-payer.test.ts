import { afterEach, expect, it } from 'vitest';
import type { EventEnvelope } from '@opencrane/events';
import { countReads, event as fixtureEvent, expectNoWholeReads, natsFixture } from '@opencrane/event-store/testing';
import { turnCommand } from '../src/chat/turns.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
async function close() {
  await nats?.close();
}
afterEach(close);

function event(id: string, subject: string, type: string) {
  const base = fixtureEvent(id, subject, type);
  const data: Record<string, unknown> = { ...base.data };
  delete data['memberId'];
  return { ...base, data };
}
function ceiling(id: string, scope: string, defaultPayingGroupId?: string): EventEnvelope {
  const base = event(id, 'budget-test', 'budget.ceiling_set');
  return { ...base, data: { scope, ceilingCents: 20000, setBy: 'alice',
    ...(scope === 'global' ? {} : { scopeId: 'group' }),
    ...(defaultPayingGroupId ? { defaultPayingGroupId } : {}) } };
}
async function start(id: string) {
  const conversationId = `chat-${id}`;
  const created = event(`created-${id}`, `conversation-${conversationId}`, 'conversation.created');
  const message = event(id, created.subject, 'message.posted');
  await nats.seed([
    { ...created, data: { ...created.data, conversationId, assistantId: 'assistant', createdBy: 'alice' } },
    { ...message, data: { ...message.data, conversationId, authorId: 'alice' } },
  ]);
  const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
  const input = { conversationId, turnId: id, threadId: `thread-${id}`, status: 'started' as const };
  return turnCommand(nats.store, context, input);
}
async function usesLatestMatchingDefaultWithoutOldBudgetReads() {
  nats = await natsFixture();
  await seedAssistant();
  await nats.seed([ceiling('first', 'global', 'first')]);
  const events = [];
  for (let index = 0; index < 497; index++) {
    events.push(event(`period-${index}`, 'budget-test', 'budget.period_started'));
  }
  events.push(ceiling('second', 'global', 'second'), ceiling('group', 'paying_group'));
  await nats.seed(events);
  expect(await start('warm')).toMatchObject({ payingGroupId: 'second' });
  await nats.seed([ceiling('third', 'global', 'third'), ceiling('no-default', 'global')]);
  const reads = countReads(nats.store);
  expect(await start('measured')).toMatchObject({ payingGroupId: 'third' });
  function isBudgetRead(call: (typeof reads.calls)[number]) {
    return call.subject === 'budget-test';
  }
  const budgetReads = reads.calls.filter(isBudgetRead);
  expectNoWholeReads(budgetReads);
  let rows = 0;
  for (const call of budgetReads) rows += call.rows;
  expect(rows).toBeLessThanOrEqual(2);
}
it('uses the newest matching personal payer and reads at most two new budget rows on 500 events',
  usesLatestMatchingDefaultWithoutOldBudgetReads);

async function seedAssistant() {
  await nats.seed([
    { ...event('assistant', 'assistant-assistant', 'assistant.created'),
      data: { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' } },
    { ...event('ready', 'computer-assistant', 'computer.ready'),
      data: { assistantId: 'assistant', computerId: 'computer', generation: 1 } },
  ]);
}
async function refusesMissingDefault() {
  nats = await natsFixture();
  await seedAssistant();
  await nats.seed([ceiling('scoped', 'paying_group'), ceiling('global', 'global')]);
  await expect(start('missing')).rejects.toThrow(
    'Paying group unavailable; configure the installation default');
}
it('keeps the personal admission refusal when no global default has been configured',
  refusesMissingDefault);
