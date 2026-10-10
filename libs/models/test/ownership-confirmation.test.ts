import { expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { history, ownershipConfirmationHandler } from '../src/index.ts';

async function fixture() {
  const nats = await natsFixture();
  let count = 0;
  async function append(subject: string, type: string, data: unknown) {
    const record = { ...event(`confirmation-${++count}`, subject, type), data };
    const expectedSequence = await nats.store.head(subject);
    const command = { event: record, expectedSequence };
    expect((await nats.store.append(command)).status).toBe('appended');
    return record;
  }
  for (const [memberId, role] of [['alice', 'owner'], ['bob', 'member'], ['charlie', 'member']]) {
    const data = { memberId, role, displayName: memberId,
      email: `${memberId}@example.test` };
    await append(`member-${memberId}`, 'member.joined', data);
  }
  const seed = { ownerIds: ['alice'] };
  await append('ownership-test', 'ownership.seeded', seed);
  const appointment = { memberId: 'bob', transferredBy: 'alice', awaitingConfirmation: true };
  const request = await append('ownership-test', 'ownership.transferred', appointment);
  const noSql = { query: unusedQuery };
  function unusedQuery(): Promise<never> {
    throw new Error('Confirmation must not use SQL');
  }
  const handler = ownershipConfirmationHandler(nats.store);
  return { nats, request, handler, noSql };
}

async function removalJustBeforeAppend() {
  const context = await fixture();
  const original = context.nats.store.append.bind(context.nats.store);
  let removed = false;
  async function removeBeforeConfirmation(command: Parameters<typeof original>[0]) {
    removed = true;
    const removal = { ...event('remove-before-confirm', 'member-bob', 'member.removed'),
      data: { memberId: 'bob', removedBy: 'alice' } };
    const expectedSequence = await context.nats.store.head('member-bob');
    const removalCommand = { event: removal, expectedSequence };
    expect((await original(removalCommand)).status).toBe('appended');
    return original(command);
  }
  const spy = vi.spyOn(context.nats.store, 'append').mockImplementationOnce(removeBeforeConfirmation);
  try {
    await expect(context.handler.handle(context.request, context.noSql))
      .rejects.toThrow('Ownership confirmation will retry');
    expect(removed).toBe(true);
    const rows = await history(context.nats.store, 'member-bob', 'test');
    expect(rows.at(-1)?.event.type).toBe('member.removed');
    expect(rows).toHaveLength(2);
  } finally {
    spy.mockRestore();
    await context.nats.close();
  }
}
it('refuses confirmation when removal arrives after the final check and before append',
  removalJustBeforeAppend);

async function invalidRequest(kind: 'absent' | 'successor' | 'owner') {
  const context = await fixture();
  const request = { ...context.request };
  if (kind === 'absent') {
    request.id = 'absent-request';
  } else {
    const memberId = kind === 'successor' ? 'charlie' : 'bob';
    const transferredBy = kind === 'owner' ? 'charlie' : 'alice';
    request.data = { memberId, transferredBy, awaitingConfirmation: true };
  }
  const writer = vi.spyOn(context.nats.store, 'append');
  try {
    await expect(context.handler.handle(request, context.noSql))
      .rejects.toThrow('Confirmation requires a saved appointment');
    expect(writer).not.toHaveBeenCalled();
  } finally {
    writer.mockRestore();
    await context.nats.close();
  }
}
it.each(['absent', 'successor', 'owner'] as const)(
  'refuses an appointment with an %s request or mismatched person', invalidRequest);
