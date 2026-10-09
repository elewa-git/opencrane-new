import { afterAll, beforeAll, expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { createStore, memberAuthorisation, rebuildMembers } from '../src/index.ts';
import { databases, openfga } from './services.ts';

let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
const noSql = { query: rejectSql };

function rejectSql() {
  return Promise.reject(new Error('Unexpected SQL'));
}

async function initialise() {
  dbs = await databases();
  fga = await openfga();
}

async function close() {
  await fga?.close();
  await dbs?.close();
}

beforeAll(initialise, 120_000);
afterAll(close);

function record(id: string, subject: string, type: string, data: unknown): EventEnvelope {
  return { ...event(id, subject, type), data };
}

const orders = [
  { appointmentFirst: true, deliverAppointmentFirst: true },
  { appointmentFirst: true, deliverAppointmentFirst: false },
  { appointmentFirst: false, deliverAppointmentFirst: true },
  { appointmentFirst: false, deliverAppointmentFirst: false },
];

async function matchesReplay(order: typeof orders[number]) {
  const nats = await natsFixture();
  try {
    const owner = record('owner-joined', 'member-owner', 'member.joined', {
      memberId: 'owner', email: 'owner@example.test', displayName: 'Owner', role: 'owner',
    });
    const member = record('bob-joined', 'member-bob', 'member.joined', {
      memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member',
    });
    const seed = record('ownership-seed-test', 'ownership-test', 'ownership.seeded', {
      ownerIds: ['owner'],
    });
    const appointment = record('bob-appointed', 'ownership-test', 'ownership.transferred', {
      memberId: 'bob', transferredBy: 'owner',
    });
    const role = record('bob-role', 'member-bob', 'member.role_changed', {
      memberId: 'bob', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
    });
    const events = [owner, member, seed];
    if (order.appointmentFirst) {
      events.push(appointment, role);
    } else {
      events.push(role, appointment);
    }
    await nats.seed(events);
    const binding = await createStore(fga.apiUrl, 'test');
    const auth = memberAuthorisation(binding, nats.store);
    for (const initial of [owner, member, seed]) {
      await auth.handler.handle(initial, noSql);
    }
    let first = role;
    let second = appointment;
    if (order.deliverAppointmentFirst) {
      first = appointment;
      second = role;
    }
    if (order.appointmentFirst !== order.deliverAppointmentFirst) {
      // Retry the first job after its earlier change has been applied on the other stream.
      await expect(auth.handler.handle(first, noSql)).rejects.toThrow('earlier');
      expect(await auth.applied(first.id)).toBe(false);
      await auth.handler.handle(second, noSql);
      await auth.handler.handle(first, noSql);
    } else {
      await auth.handler.handle(first, noSql);
      await auth.handler.handle(second, noSql);
    }
    expect(await auth.applied(role.id)).toBe(true);
    expect(await auth.applied(appointment.id)).toBe(true);
    expect((await auth.check('bob', 'owner')).allowed).toBe(true);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, {
      verifyAgainst: binding,
    });
    expect(rebuilt.verified).toBe(true);
    await auth.handler.handle(role, noSql);
    await auth.handler.handle(appointment, noSql);
    await rebuildMembers(fga.apiUrl, 'test', nats.reader, { verifyAgainst: binding });
  } finally {
    await nats.close();
  }
}

it.each(orders)('matches replay for saved and delivered appointment order $appointmentFirst / '
  + '$deliverAppointmentFirst', matchesReplay);
