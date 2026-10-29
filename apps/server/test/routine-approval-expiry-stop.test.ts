import { afterEach, expect, it } from 'vitest';
import { BudgetActor, envelope, history, priceTableId } from '@opencrane/models';
import { rootTotals } from '../../../libs/models/src/root-budget.ts';
import { expireRoutineApproval } from '../src/routine-approval-expiry.ts';
import { stopRoutineAfterApproval } from '../src/routine-approval-stop.ts';
import { applyRoutineStop } from '../src/routine-stop-budget.ts';
import { expiryFixture } from './support/routine-expiry.ts';

let fixture: Awaited<ReturnType<typeof expiryFixture>>;
async function close() { await fixture?.nats.close(); }
afterEach(close);
async function expiresAndStops() {
  fixture = await expiryFixture();
  const { nats, input, binding, rootId, now } = fixture;
  let actor = fixture.actor;
  const { allowanceCents: _allowance, preparationDigest: _digest, ...identity } = binding;
  const call = { ...identity, model: 'gpt-6-luna', priceTableId, contextDigest: '0'.repeat(64) };
  const held = await actor.reserve(call, 1, undefined, undefined, rootId);
  await actor.uncertain(held, 'settle_timeout');
  fixture.advance(900_000);
  const options = { enabled: true, now };
  const expired = await expireRoutineApproval(nats.store, 'test', input, options);
  if (expired.status !== 'confirmed') throw new Error('Missing expiry');
  const cause = { eventId: expired.eventId, position: expired.position };
  const command = { routineId: 'orders', occurrenceId: 'occurrence', cause,
    expectedPosition: await nats.store.head('routine-orders'), expectedDefinitionRevision: 1,
    expectedScheduleRevision: 1, expectedControlRevision: 1 };
  const stopped = await stopRoutineAfterApproval(nats.store, 'test', command);
  expect(await stopRoutineAfterApproval(nats.store, 'test', command)).toEqual(stopped);
  const reference = { routineId: 'orders', eventId: stopped.eventId, position: stopped.position };
  const beforeReplay = await nats.store.head();
  expect(await applyRoutineStop(nats.store, 'test', reference, actor,
    { enabled: true, replay: true })).toEqual({ status: 'disabled' });
  expect(await nats.store.head()).toBe(beforeReplay);
  expect(await applyRoutineStop(nats.store, 'test', reference, actor, options))
    .toEqual({ status: 'confirmed' });
  expect(rootTotals(actor.state, rootId).heldCents).toBe(1);
  await nats.stop();
  await nats.restart();
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  expect(await expireRoutineApproval(nats.store, 'test', input, options)).toEqual(expired);
  const settlement = { reservationId: held, permitId: held, settledCents: 1234,
    outcome: 'settled', resolvedBy: 'owner', evidence: [{ kind: 'provider_receipt',
      reference: 'receipt', digest: '0'.repeat(64), amountCents: 1234 }] };
  const resolved = envelope('test', `effect-${held}`, 'effect.resolved', settlement);
  resolved.principal = { kind: 'human', id: 'owner' };
  await actor.settle(resolved);
  expect(rootTotals(actor.state, rootId)).toEqual({
    settledCents: 1234, heldCents: 0, availableCents: 0 });
  await expect(actor.reserve(call, 1, undefined, undefined, rootId))
    .rejects.toMatchObject({ reason: 'routine_stop' });
  expect(await applyRoutineStop(nats.store, 'test', reference, actor, options))
    .toEqual({ status: 'confirmed' });
  const rows = await history(nats.store, 'routine-orders', 'test');
  function isStop(row: (typeof rows)[number]) {
    return row.event.type === 'routine.run_stop_requested';
  }
  expect(rows.filter(isStop)).toHaveLength(1);
  expect(actor.state.dispatches).toEqual([]);
}
it('feeds saved offline expiry to one Stop, retains uncertain holds and settles full late cents',
  expiresAndStops);
