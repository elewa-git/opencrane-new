import { afterEach, expect, it, vi } from 'vitest';
import { manualClock, natsFixture, event } from '@opencrane/event-store/testing';
import { EventStore } from '@opencrane/event-store';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { authorityFence } from '../src/authority.ts';
import { payingGroupAuthority } from '../src/paying-group.ts';
import { BudgetActor } from '../src/actor.ts';
import { accessDeadline } from '../src/budget-writer.ts';

let nats: Awaited<ReturnType<typeof natsFixture>> | undefined;
async function close() {
  vi.restoreAllMocks();
  await nats?.close();
  nats = undefined;
}
afterEach(close);

async function authorityDeadline(expired: boolean) {
  const clock = manualClock();
  async function head() {
    return 0;
  }
  async function* readStream() {}
  const store = { clock, head, readStream };
  const fresh = await authorityFence(store, clock.now(), ['member-alice']);
  if (expired) clock.advance(2001);
  if (expired) {
    await expect(fresh()).rejects.toThrow('Authority snapshot expired');
  } else {
    await expect(fresh()).resolves.toBeUndefined();
  }
}
it.each([false, true])('uses manual time for authority confirmation (expired: %s)',
  authorityDeadline);

async function payingDeadline(expired: boolean) {
  const clock = manualClock();
  nats = await natsFixture({ clock });
  const joined = event('joined');
  const team = { ...event('team', 'team-sales', 'team.created'),
    data: { teamId: 'sales', name: 'Sales', createdBy: 'alice' } };
  const member = { ...event('team-member', 'team-sales', 'team.member_added'),
    data: { teamId: 'sales', memberId: 'alice', addedBy: 'alice' } };
  await nats.seed([joined, team, member]);
  const fresh = await payingGroupAuthority(nats.store, 'test', 'alice', 'sales');
  const head = nats.store.head.bind(nats.store);
  const teamHead = await head('team-sales');
  const memberHead = await head('member-alice');
  async function savedHead(subject?: string) {
    if (subject === 'team-sales') return teamHead;
    return memberHead;
  }
  // Isolate the access check from the event store's own deadline refusal.
  vi.spyOn(nats.store, 'head').mockImplementation(savedHead);
  if (expired) clock.advance(2001);
  if (expired) {
    await expect(fresh()).rejects.toThrow('Paying group authority changed');
  } else {
    await expect(fresh()).resolves.toBeUndefined();
  }
}
it.each([false, true])('uses manual time for group authority (expired: %s)', payingDeadline);

async function actorDeadline(expired: boolean) {
  const clock = manualClock();
  nats = await natsFixture({ clock });
  const actor = new BudgetActor(nats.store, 'test');
  const append = nats.store.append.bind(nats.store);
  let deadline: number | undefined;
  async function save(command: Parameters<typeof append>[0]) {
    deadline = command.deadline;
    if (expired) clock.advance(2001);
    return append(command);
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(save);
  const starting = actor.start();
  if (expired) {
    await expect(starting).rejects.toThrow('Budget append unavailable');
  } else {
    await starting;
  }
  expect(deadline).toBe(2000);
}
it.each([false, true])('uses manual time for the actor queue (expired: %s)', actorDeadline);

async function fallbackDeadline(expired: boolean) {
  const clock = manualClock();
  const deadline = accessDeadline({ clock });
  expect(deadline).toBe(2000);
  if (expired) clock.advance(2001);
  nats = await natsFixture({ clock });
  const manager = await jetstreamManager(nats.connection);
  const store = new EventStore(jetstream(nats.connection), manager, manager, clock);
  const result = await store.append({ event: event('fallback'), expectedSequence: 0, deadline });
  if (expired) {
    expect(result.status).toBe('unavailable');
  } else {
    expect(result.status).toBe('appended');
  }
}
it.each([false, true])('uses manual time for fallback access limits (expired: %s)',
  fallbackDeadline);
