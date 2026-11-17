import { expect, it } from 'vitest';
import { toolApprovalRequestedDataSchema } from '@opencrane/events';
import { envelope, history } from '@opencrane/models';
import { approvalInvalidation } from '../../../libs/models/src/approval-invalidation.ts';
import { approvalFixture } from './support/approval-fixture.ts';

async function invalidatesSnapshot(missingStart: boolean, type: string) {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).status).toBe(403);
    const approvalId = (await setup.read()).cards[0]!.approvalId;
    const approval = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    const first = approval[0]!;
    const request = toolApprovalRequestedDataSchema.parse(first.event.data);
    const subject = 'conversation-conversation';
    const details: Record<string, string> = {};
    if (type === 'agent.turn_failed') details['reason'] = 'model_error';
    if (type === 'agent.turn_stop_requested') details['requestedBy'] = 'alice';
    const event = envelope('test', subject, type, { conversationId: 'conversation',
      turnId: 'other-turn', ...details });
    await setup.nats.seed([event]);
    const position = await setup.nats.store.head();
    const rows = await history(setup.nats.store, subject, 'test');
    function keepStart(row: typeof rows[number]) {
      return !missingStart || row.event.type !== 'agent.turn_started';
    }
    const conversationRows = rows.filter(keepStart);
    const snapshot = { conversationRows, conversationPosition: position };
    const read = { request, requestPosition: first.sequence, deadline: Infinity, snapshot };
    const result = await approvalInvalidation(setup.nats.store, 'test', read);
    expect(result.closed).toBe(missingStart);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}

async function ignoresOtherTurn(type: string) {
  await invalidatesSnapshot(false, type);
}
async function refusesMissingStart() {
  await invalidatesSnapshot(true, 'agent.turn_completed');
}
it.each(['agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested'])(
  'keeps an approval when an unprojected other turn emits %s', ignoresOtherTurn, 40_000);
it('refuses an approval snapshot with its bound turn start missing', refusesMissingStart, 40_000);

async function refusesAbsentPreparedRows() {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).status).toBe(403);
    const approvalId = (await setup.read()).cards[0]!.approvalId;
    const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    const first = rows[0]!;
    const request = toolApprovalRequestedDataSchema.parse(first.event.data);
    const read = { request, requestPosition: first.sequence, deadline: Infinity, snapshot: {} };
    await expect(approvalInvalidation(setup.nats.store, 'test', read))
      .rejects.toThrow('Approval conversation history unavailable');
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it('refuses an approval when its prepared conversation rows are absent',
  refusesAbsentPreparedRows, 40_000);
