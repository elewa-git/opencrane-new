import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation, rebuildMembers } from '../src/index.ts';
import { objectId, TupleClient } from '../src/client.ts';
import { routine, joinedMember, history } from './routine-fixture.ts';
import { openfga } from './services.ts';

function rejectSql(): never {
  throw new Error('Routine permissions cannot write SQL');
}
const db = { query: rejectSql };
const deliveryOrders = [
  [0, 2, 1],
  [2, 1, 0],
  [2, 0, 1],
  [1, 2, 0],
  [1, 0, 2],
  [0, 1, 2],
];

async function retirementMatchesReplay(order: number[]) {
  const nats = await natsFixture();
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const auth = memberAuthorisation(binding, nats.store);
    const client = new TupleClient(binding);
    for (const memberId of ['alice', 'bob', 'admin']) {
      const joined = joinedMember(memberId);
      await nats.seed([joined]);
      await auth.handler.handle(joined, db);
    }
    const created = routine('routine.created');
    const reassigned = routine('routine.reassigned', 'bob');
    const retired = routine('routine.retired');
    const saved = [created, reassigned, retired];
    for (const event of saved) {
      await nats.seed([event]);
    }
    let retirementApplied = false;
    for (const index of order) {
      const event = saved[index]!;
      await auth.handler.handle(event, db);
      retirementApplied ||= event === retired;
      if (retirementApplied) {
        for (const memberId of ['alice', 'bob', 'admin']) {
          const tuple = { user: objectId('person', 'test', memberId),
            object: objectId('routine', 'test', 'orders'), relation: 'manage' };
          expect(await client.check(tuple)).toEqual({ allowed: false, status: 'ok' });
        }
      }
    }
    expect(await auth.routine('bob', 'orders', 'read_metadata'))
      .toEqual({ allowed: true, status: 'ok' });
    expect(await auth.routine('alice', 'orders', 'read_metadata'))
      .toEqual({ allowed: false, status: 'ok' });
    expect(await auth.routine('admin', 'orders', 'read_metadata'))
      .toEqual({ allowed: true, status: 'ok' });
    for (const event of saved) {
      expect(await auth.applied(event.id)).toBe(true);
      await auth.handler.handle(event, db);
    }
    const options = { verifyAgainst: binding };
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, options);
    expect(rebuilt.verified).toBe(true);
    const replayed = memberAuthorisation(rebuilt.binding, nats.store);
    expect(await replayed.routine('bob', 'orders', 'read_metadata'))
      .toEqual({ allowed: true, status: 'ok' });
    expect(await replayed.routine('bob', 'orders', 'manage'))
      .toEqual({ allowed: false, status: 'ok' });
  } finally {
    await fga.close();
    await nats.close();
  }
}

function namedOrder(order: number[]) {
  return { order };
}
async function checkOrder({ order }: { order: number[] }) {
  await retirementMatchesReplay(order);
}
const cases = deliveryOrders.map(namedOrder);
it.each(cases)(
  'keeps the saved retired owner and matches replay for delivery $order',
  checkOrder, 30_000);

async function retirementRequiresHistory(scenario: string) {
  const fga = await openfga();
  try {
    const binding = await createStore(fga.apiUrl, 'test');
    const created = routine('routine.created');
    const retired = routine('routine.retired');
    let saved = [created, retired];
    if (scenario === 'missing retirement') {
      saved = [created];
    }
    if (scenario === 'missing creation') {
      saved = [retired];
    }
    let store: ReturnType<typeof history> | undefined = history(saved);
    if (scenario === 'missing store') {
      store = undefined;
    }
    const auth = memberAuthorisation(binding, store);
    await auth.handler.handle(created, db);
    const client = new TupleClient(binding);
    const before = await client.read({});
    await expect(auth.handler.handle(retired, db)).rejects.toThrow();
    expect(await auth.applied(retired.id)).toBe(false);
    expect(await client.read({})).toEqual(before);
  } finally {
    await fga.close();
  }
}
it.each(['missing store', 'missing retirement', 'missing creation'])(
  'leaves retirement unreceipted with %s', retirementRequiresHistory, 30_000);
