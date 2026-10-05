import { expect, it } from 'vitest';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { dispatch, HandlerRuntime, provisionDispatcher, registerHandler } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { seedOwnership } from '@opencrane/models';
import { pgDb, type Query } from '@opencrane/projections';

async function ordersMigration() {
  const nats = await natsFixture();
  const fga = await openfga();
  const dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  let release!: () => void;
  let entered!: () => void;
  function captureRelease(resolve: () => void) {
    release = resolve;
  }
  function captureEntry(resolve: () => void) {
    entered = resolve;
  }
  const blocked = new Promise<void>(captureRelease);
  const demotionEntered = new Promise<void>(captureEntry);
  async function apply(record: EventEnvelope, transaction: Query) {
    if (record.id === 'demote-alice') {
      entered();
      await blocked;
    }
    await auth.handler.handle(record, transaction);
  }
  const handler = registerHandler('update-openfga', apply);
  const options = { db, silo: 'test', logger: createLogger('ownership-order', { level: 'silent' }),
    handlers: [handler], retryLimit: 1 };
  const runtime = new HandlerRuntime(options);
  const controller = new AbortController();
  let dispatching: Promise<void> | undefined;
  async function append(id: string, subject: string, type: string, data: unknown) {
    const record = { ...event(id, subject, type), data };
    const expectedSequence = await nats.store.head(subject);
    const command = { event: record, expectedSequence };
    const result = await nats.store.append(command);
    expect(result.status).toBe('appended');
  }
  async function bothOwners() {
    const alice = await auth.check('alice', 'owner');
    const bob = await auth.check('bob', 'owner');
    return alice.allowed && bob.allowed;
  }
  async function sentinelApplied() {
    return auth.applied('sentinel');
  }
  async function demotionApplied() {
    return auth.applied('demote-alice');
  }
  async function seedApplied() {
    return auth.applied('ownership-seed-test');
  }
  function dispatchFailed(error: unknown) {
    if (!controller.signal.aborted) {
      throw error;
    }
  }
  try {
    await runtime.start();
    await provisionDispatcher(nats.connection);
    dispatching = dispatch(nats.dispatcherConnection, runtime, controller.signal);
    const observed = dispatching.catch(dispatchFailed);
    await runtime.work();
    for (const memberId of ['alice', 'bob']) {
      await append(`join-${memberId}`, `member-${memberId}`, 'member.joined', {
        memberId, email: `${memberId}@example.test`, displayName: memberId, role: 'owner',
      });
    }
    await until(bothOwners);
    await append('demote-alice', 'member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'owner', newRole: 'admin', changedBy: 'bob',
    });
    await demotionEntered;
    await seedOwnership(nats.store, 'test');
    await append('sentinel', 'team-sentinel', 'team.created', {
      teamId: 'sentinel', name: 'Sentinel', createdBy: 'bob',
    });
    // Another key completes while this silo's older demotion holds ownership behind it.
    await until(sentinelApplied);
    expect(await auth.applied('ownership-seed-test')).toBe(false);
    release();
    await until(demotionApplied);
    await until(seedApplied);
    expect((await auth.check('alice', 'owner')).allowed).toBe(false);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, { verifyAgainst: binding });
    expect((await rebuilt.check('bob', 'owner')).allowed).toBe(true);
    controller.abort();
    await observed;
  } finally {
    release();
    controller.abort();
    await dispatching;
    await runtime.stop();
    await dbs.close();
    await fga.close();
    await nats.close();
  }
}
it('live IAM delivery orders a delayed legacy demotion before seeding and matches replay',
  ordersMigration, 120_000);
