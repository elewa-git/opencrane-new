import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, onTestFinished, type TestContext } from 'vitest';
import { WebSocket } from 'ws';
import { event } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { members, pgDb, rebuildMemberProjection } from '@opencrane/projections';
import type { RealtimeMessage } from '@opencrane/protocol';
import { checkClosure, checkDelivery, checkReplicas, type Delivery } from './realtime-replicas-check.ts';
import { closeReplicas, replicasFixture, startReplica } from './realtime-replicas-fixture.ts';

type Fixture = Awaited<ReturnType<typeof replicasFixture>>;
type Connection = Awaited<ReturnType<Fixture['connect']>>;
const canary = 'fixture-only-sensitive-canary';

function member(silo: string, id: string, position: number, generation = 0): RealtimeMessage {
  const invited = position === 1;
  let role: 'admin' | 'member' = 'member';
  if (id === 'alice' && !invited) role = 'admin';
  let displayName: string | null = `${silo} ${id}`;
  if (invited) displayName = null;
  return { version: 1, topic: 'members', type: 'member', position, generation,
    member: { memberId: id, email: `${id}@${silo}.example.test`, displayName,
      role, status: invited ? 'invited' : 'joined' } };
}

async function refusesUpgrade(fixture: Fixture, headers: Record<string, string>, status = 403) {
  const connection = await fixture.connect(fixture.second, headers);
  await connection.waitClosed();
  const body = status === 401 ? 'Unauthorized' : 'Forbidden';
  expect(connection.upgrade).toEqual({ status, body });
  expect(connection.replies).toEqual([]);
  const sentCookie = headers['cookie'] ?? canary;
  expect(fixture.second.stdout().includes(sentCookie)).toBe(false);
}

async function refusesForeignBrowser(local: Fixture, foreign: Fixture, organisation: string) {
  const foreignCookie = foreign.headers();
  foreignCookie['origin'] = local.headers()['origin'] ?? '';
  foreignCookie['authorization'] = `Bearer ${canary}`;
  await refusesUpgrade(local, foreignCookie, 401);
  const wrongOrigin = local.headers();
  wrongOrigin['origin'] = foreign.headers()['origin'] ?? '';
  await refusesUpgrade(local, wrongOrigin);
  const missingOrigin = local.headers();
  delete missingOrigin['origin'];
  await refusesUpgrade(local, missingOrigin);
  await refusesUpgrade(local, local.headers(organisation));
}

async function unrelatedChat(fixture: Fixture, connection: Connection) {
  const raw = event('unrelated', 'conversation-unrelated', 'conversation.created');
  const saved = { ...raw, silo: 'silo-a', data: { conversationId: 'unrelated',
    assistantId: 'other', createdBy: 'other', mode: 'agent_session' } };
  expect((await fixture.nats.store.append({ expectedSequence: 0, event: saved })).status)
    .toBe('appended');
  await fixture.runner.run(members);
  await delay(1100);
  expect(connection.socket.readyState).toBe(WebSocket.OPEN);
}

async function survivingAccess(fixture: Fixture, connection: Connection) {
  const accepted = connection.messages.length;
  await fixture.fga.pause();
  try {
    const existingCode = await connection.waitClosed();
    // Allow the existing read-error or access-poll outcome when both are active.
    expect([1011, 1013]).toContain(existingCode);
    checkClosure(connection.messages.slice(accepted), existingCode, existingCode);
    const outage = await fixture.connect(fixture.second);
    outage.subscribe();
    const code = await outage.waitClosed();
    expect([1011, 1013]).toContain(code);
    checkClosure(outage.messages, code, code);
  } finally {
    await fixture.fga.resume();
  }
  const recovered = await fixture.connect(fixture.second);
  recovered.subscribe();
  await recovered.waitFor('ready');
  const count = recovered.messages.length;
  await fixture.append('alice', 'member.removed', {}, false);
  expect((await fixture.authz.check('alice', 'admin')).allowed).toBe(true);
  const rows = await fixture.dbs.queue.query(
    "SELECT role, status FROM members WHERE member_id = 'alice'");
  expect(rows.rows).toEqual([{ role: 'admin', status: 'joined' }]);
  const code = await recovered.waitClosed();
  checkClosure(recovered.messages.slice(count), code, 1008, 'refused');
  const refused = await fixture.connect(fixture.second);
  refused.subscribe(3, 0);
  checkClosure(refused.messages, await refused.waitClosed(), 1008, 'refused');
}

async function checksRebuiltSilo(local: Fixture, foreign: Fixture, cursor: Delivery) {
  // A position is a resume hint. With B's own session it can return only B's rows.
  const overlapping = await local.connect(local.second);
  overlapping.subscribe(cursor.position, cursor.generation);
  await overlapping.waitFor('ready');
  checkDelivery(overlapping.replies, [member('silo-b', 'carol', 4)]);
  const overlapCount = overlapping.messages.length;
  await local.dbs.queue.query("UPDATE members SET display_name = 'damaged'");
  const repaired = await rebuildMemberProjection(pgDb(local.dbs.queue), local.nats.reader,
    createLogger('isolation-repair'));
  expect(repaired.changed).toBe(true);
  const resetCode = await overlapping.waitClosed();
  checkClosure(overlapping.messages.slice(overlapCount), resetCode, 1013, 'resync', 1);
  checkDelivery(overlapping.replies, [member('silo-b', 'carol', 4)]);
  const stale = await local.connect(local.second);
  stale.subscribe(cursor.position, cursor.generation);
  checkClosure(stale.messages, await stale.waitClosed(), 1013, 'resync', 1);
  expect(stale.replies).toEqual([
    { version: 1, topic: 'members', type: 'resync', position: 0, generation: 1 },
  ]);
  await refusesForeignBrowser(local, foreign, 'org-a');
  const rebuilt = await local.connect(local.second);
  rebuilt.subscribe(0, 1);
  await rebuilt.waitFor('ready');
  await local.second.stop();
  expect(await rebuilt.waitClosed()).toBe(1001);
  expect(rebuilt.replies).toEqual([member('silo-b', 'alice', 1, 1),
    member('silo-b', 'alice', 2, 1), member('silo-b', 'bob', 3, 1),
    member('silo-b', 'carol', 4, 1),
    { version: 1, topic: 'members', type: 'ready', position: 4, generation: 1 },
  ]);
}

async function isolatesReconnectAndRebuild(context: TestContext) {
  const siloA = await replicasFixture({ silo: 'silo-a', organisation: 'org-a',
    origin: 'https://a.example.test' });
  const original = await siloA.connect(siloA.first);
  original.subscribe();
  await original.waitFor('ready');
  await siloA.append('bob');
  await original.waitFor('member', 3);
  const cursor = original.messages.at(-1);
  expect(cursor).toEqual({ type: 'member', memberId: 'bob', position: 3, generation: 0 });
  if (!cursor) throw new Error('Missing cursor');
  await siloA.first.stop();
  expect((await siloA.first.exited).code).toBe(0);
  expect(await original.waitClosed()).toBe(1001);

  const siloB = await replicasFixture({ silo: 'silo-b', organisation: 'org-b',
    origin: 'https://b.example.test' });
  checkReplicas(siloA.second, siloB.second);
  expect(siloA.authz.binding.storeId).not.toBe(siloB.authz.binding.storeId);
  expect(siloA.dbs.queue.options.connectionString)
    .not.toBe(siloB.dbs.queue.options.connectionString);
  expect(siloA.nats.env().NATS_URL).not.toBe(siloB.nats.env().NATS_URL);
  await siloB.first.stop();
  await siloB.append('bob');
  await siloB.append('carol');
  await siloA.append('carol');
  const resumed = await siloA.connect(siloA.second);
  resumed.subscribe(cursor.position, cursor.generation);
  await resumed.waitFor('ready');
  await unrelatedChat(siloA, resumed);
  await siloA.append('dan');
  await resumed.waitFor('member', 6);
  checkDelivery(original.replies,
    [member('silo-a', 'alice', 1), member('silo-a', 'alice', 2), member('silo-a', 'bob', 3)]);
  checkDelivery(resumed.replies, [member('silo-a', 'carol', 4), member('silo-a', 'dan', 6)]);
  await refusesForeignBrowser(siloB, siloA, 'org-a');
  await refusesForeignBrowser(siloA, siloB, 'org-b');

  await checksRebuiltSilo(siloB, siloA, cursor);
  await siloA.append('erin');
  await resumed.waitFor('member', 7);
  await survivingAccess(siloA, resumed);
  checkDelivery(resumed.replies, [member('silo-a', 'carol', 4),
    member('silo-a', 'dan', 6), member('silo-a', 'erin', 7)]);
  for (const fixture of [siloA, siloB]) {
    for (const server of [fixture.first, fixture.second]) {
      expect(server.stdout().includes(canary)).toBe(false);
    }
    expect(JSON.stringify(fixture.evidence).includes(canary)).toBe(false);
    await context.annotate(JSON.stringify(fixture.evidence));
  }
}
it('keeps two silos and browser Origins separate through reconnect, rebuild and access loss',
  isolatesReconnectAndRebuild, 120_000);

function childImport(source: string) {
  return { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(source)}` };
}

async function sanitisesStartup() {
  const settings = childImport(`process.stderr.write('${canary}'); throw Error('${canary}');`);
  await expect(startReplica(settings)).rejects.toEqual(new Error('Replica startup failed'));
  await expect(replicasFixture({ origin: canary })).rejects.toEqual(
    new Error('Replica fixture setup failed'));
}
it('discards child output and setup errors containing a sensitive canary', sanitisesStartup, 60_000);

async function sanitisesShutdown() {
  const settings = childImport(`process.stderr.write('${canary}');
    process.once('SIGTERM', () => process.exit(2));`);
  const server = await startReplica(settings);
  onTestFinished(server.stop);
  await expect(server.stop()).rejects.toEqual(new Error('Replica shutdown failed'));
  expect((await server.exited).code).toBe(2);
  let cleaned = false;
  function remainingResource() {
    cleaned = true;
    return Promise.resolve();
  }
  function failedResource() {
    return Promise.reject(new Error(canary));
  }
  await expect(closeReplicas([remainingResource, failedResource])).rejects.toEqual(
    new Error('Replica fixture cleanup failed'));
  expect(cleaned).toBe(true);
}
it('sanitises child shutdown and cleanup errors while releasing remaining resources',
  sanitisesShutdown, 60_000);
