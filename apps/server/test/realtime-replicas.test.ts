import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, type TestContext } from 'vitest';
import { WebSocket } from 'ws';
import { until } from '@opencrane/authz/testing';
import { event } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { members, pgDb, rebuildMemberProjection } from '@opencrane/projections';
import { checkClosure, checkDelivery } from './realtime-replicas-check.ts';
import { replicasFixture } from './realtime-replicas-fixture.ts';

async function reconnectsAcrossProcesses(context: TestContext) {
  const fixture = await replicasFixture();
  const { first, second, connect, append, dbs, runner, nats } = fixture;
  const original = await connect(first);
  original.subscribe();
  await original.waitFor('ready');
  const before = await append('bob');
  await original.waitFor('member', before.position);
  const cursor = original.messages.at(-1);
  if (!cursor) throw new Error('Missing accepted cursor');
  await first.stop();
  expect((await first.exited).code).toBe(0);
  expect(await original.waitClosed()).toBe(1001);
  const disconnected = await append('carol');
  const resumed = await connect(second);
  const transaction = await dbs.queue.connect();
  let during;
  try {
    await transaction.query('BEGIN');
    await transaction.query('LOCK TABLE member_changes IN ACCESS EXCLUSIVE MODE');
    resumed.subscribe(cursor.position, cursor.generation);
    async function waitingForHistory() {
      const result = await dbs.queue.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE 'SELECT%member_changes%'`);
      return result.rowCount !== 0;
    }
    await until(waitingForHistory, 5000);
    during = await append('dan', 'member.joined', {}, false);
  } finally {
    await transaction.query('ROLLBACK');
    transaction.release();
  }
  await runner.run(members);
  await resumed.waitFor('member', during.position);
  await resumed.waitFor('ready');
  const unrelated = event('unrelated-chat', 'conversation-unrelated', 'conversation.created');
  const conversation = { ...unrelated, data: { conversationId: 'unrelated',
    assistantId: 'other', createdBy: 'other', mode: 'agent_session' } };
  const saved = await nats.store.append({ expectedSequence: 0, event: conversation });
  expect(saved.status).toBe('appended');
  await runner.run(members);
  // Cross several permission polls after unrelated conversation activity.
  await delay(1100);
  expect(resumed.socket.readyState).toBe(WebSocket.OPEN);
  const after = await append('erin');
  await resumed.waitFor('member', after.position);
  await second.stop();
  expect(await resumed.waitClosed()).toBe(1001);
  checkDelivery([...original.messages, ...resumed.messages],
    [...fixture.initial, before, disconnected, during, after]);
  checkDelivery(resumed.messages, [disconnected, during, after]);
  await context.annotate(JSON.stringify(fixture.evidence));
}
it('resumes on another process through stopped, reconnecting and live delivery',
  reconnectsAcrossProcesses, 90_000);

async function refusesSavedRevocation(change: 'member.removed' | 'member.role_changed',
  context: TestContext) {
  const { first, second, connect, append, authz, dbs, evidence } = await replicasFixture();
  const original = await connect(first);
  original.subscribe();
  await original.waitFor('ready');
  const cursor = original.messages.at(-1);
  if (!cursor) throw new Error('Missing accepted cursor');
  await first.stop();
  let data = {};
  if (change === 'member.role_changed') {
    data = { previousRole: 'admin', newRole: 'member', changedBy: 'owner' };
  }
  await append('alice', change, data, false);
  expect((await authz.check('alice', 'admin')).allowed).toBe(true);
  const sql = await dbs.queue.query("SELECT role, status FROM members WHERE member_id = 'alice'");
  expect(sql.rows).toEqual([{ role: 'admin', status: 'joined' }]);
  const resumed = await connect(second);
  resumed.subscribe(cursor.position, cursor.generation);
  const code = await resumed.waitClosed();
  checkClosure(resumed.messages, code, 1008, 'refused');
  await context.annotate(JSON.stringify(evidence));
}
it.for(['member.removed', 'member.role_changed'] as const)(
  'refuses saved %s on the second process while SQL and OpenFGA lag',
  { timeout: 90_000 }, refusesSavedRevocation);

async function failsClosedDuringOutage(context: TestContext) {
  const { first, second, connect, fga, evidence } = await replicasFixture();
  const original = await connect(first);
  original.subscribe();
  await original.waitFor('ready');
  const accepted = original.messages.length;
  await fga.pause();
  try {
    const originalCode = await original.waitClosed();
    // Allow either existing close path when a feed read races the access poll.
    expect([1011, 1013]).toContain(originalCode);
    checkClosure(original.messages.slice(accepted), originalCode, originalCode);
    const resumed = await connect(second);
    resumed.subscribe();
    // Initial dependency errors use 1011; the access watchdog uses 1013.
    const code = await resumed.waitClosed();
    expect([1011, 1013]).toContain(code);
    checkClosure(resumed.messages, code, code);
  } finally { await fga.resume(); }
  await context.annotate(JSON.stringify(evidence));
}
it('closes and refuses across processes when real OpenFGA stops answering',
  failsClosedDuringOutage, 90_000);

async function resetsStaleGeneration(context: TestContext) {
  const { first, second, connect, dbs, nats, evidence } = await replicasFixture();
  const original = await connect(first);
  original.subscribe();
  await original.waitFor('ready');
  const cursor = original.messages.at(-1);
  if (!cursor) throw new Error('Missing accepted cursor');
  await first.stop();
  // Damage only a disposable projection to exercise the existing repair/reset path.
  await dbs.queue.query("UPDATE members SET display_name = 'Wrong' WHERE member_id = 'alice'");
  const repaired = await rebuildMemberProjection(pgDb(dbs.queue), nats.reader,
    createLogger('replica-repair'));
  expect(repaired.changed).toBe(true);
  const stale = await connect(second);
  stale.subscribe(cursor.position, cursor.generation);
  const code = await stale.waitClosed();
  checkClosure(stale.messages, code, 1013, 'resync');
  expect(stale.messages[0]).toMatchObject({ position: 0, generation: cursor.generation + 1 });
  const fresh = await connect(second);
  fresh.subscribe(0, cursor.generation + 1);
  await fresh.waitFor('ready');
  const expected = [];
  for (const memberId of ['alice', 'alice']) {
    expected.push({ type: 'member' as const, memberId,
      position: expected.length + 1, generation: cursor.generation + 1 });
  }
  await second.stop();
  await fresh.waitClosed();
  checkDelivery(fresh.messages, expected);
  await context.annotate(JSON.stringify(evidence));
}
it('resets a stale generation on the second process and reloads corrected history',
  resetsStaleGeneration, 90_000);
