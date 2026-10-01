import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { parseEventByType } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { realtimeMessageSchema, type RealtimeMessage } from '@opencrane/protocol';
import { startServer, TEST_OIDC_ENV, type RunningServer } from './support/process.ts';

const env = { ...TEST_OIDC_ENV, OIDC_EXPECTED_ORG_ID: 'org-acme', SILO_ID: 'test' };
const config = loadAuthConfig(env);
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let runner: ProjectionRunner;
let authz: ReturnType<typeof memberAuthorisation>;
let server: RunningServer;
let sequence = 0;
const sockets: WebSocket[] = [];
beforeAll(async () => { fga = await openfga(); }, 120_000);
afterAll(async () => { await fga.close(); });
beforeEach(async () => {
  dbs = await databases();
  nats = await natsFixture();
  sequence = 0;
  runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader, createLogger('realtime-test'));
  await runner.initialise(members);
  authz = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  await append('alice', 'member.invited', { invitationId: 'invite-alice',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-alice' } });
  await append('alice', 'member.joined', { invitationId: 'invite-alice' });
  const binding = authz.binding;
  server = await startServer({ ...env, ...nats.env(), DATABASE_URL: dbs.queue.options.connectionString,
    OPENFGA_API_URL: binding.apiUrl, OPENFGA_STORE_ID: binding.storeId, OPENFGA_MODEL_ID: binding.authorizationModelId });
}, 30_000);
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.stop();
  await nats?.close();
  await dbs?.close();
});
async function append(id: string, type = 'member.joined', data = {}, project = true) {
  const raw = event(`realtime-${++sequence}`, `member-${id}`, type);
  const parsed = parseEventByType({ ...raw, principal: { kind: 'human', id: `oidc-${id}` }, data: { ...raw.data, ...data } });
  if (!parsed.success) throw new Error('Invalid fixture');
  let expectedSequence = 0;
  for await (const stored of nats.store.readStream(raw.subject)) expectedSequence = stored.sequence;
  const result = await nats.store.append({ expectedSequence, event: parsed.event });
  expect(result.status).toBe('appended');
  if (type !== 'member.invited') await authz.handler.handle(parsed.event, pgDb(dbs.queue));
  if (project) await runner.run(members);
}
function headers(sub = 'oidc-alice', orgId = 'org-acme') {
  const now = Math.floor(Date.now() / 1000);
  return { origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(config,
    { sub, orgId, roles: ['owner'], authTime: now, exp: now + 60 })}` };
}
async function connect(sub = 'oidc-alice', org = 'org-acme', autoPong = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: headers(sub, org), autoPong });
  sockets.push(ws);
  const messages: RealtimeMessage[] = [];
  ws.on('message', (raw: Buffer) => messages.push(realtimeMessageSchema.parse(JSON.parse(raw.toString()))));
  await once(ws, 'open');
  return { ws, messages, subscribe(since = 0) { ws.send(JSON.stringify({ type: 'subscribe', topic: 'members', since })); } };
}
it.each(['cookie', 'origin', 'missing-origin'])('refuses an upgrade with bad %s in the real process', async (kind) => {
  const h: Record<string, string> = headers();
  if (kind === 'cookie') delete h['cookie'];
  if (kind === 'origin') h['origin'] = 'https://evil.example.test';
  if (kind === 'missing-origin') delete h['origin'];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: h });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    ws.on('unexpected-response', (_request, response) => { resolve(response.statusCode); response.resume(); ws.terminate(); });
    ws.on('error', reject);
  });
  expect(status).toBe(kind === 'cookie' ? 401 : 403);
});
it.each([['unknown', 'org-acme'], ['oidc-alice', 'other'], ['alice', 'org-acme']])('refuses identity %s in organisation %s regardless of cookie roles', async (sub, org) => {
  const client = await connect(sub, org);
  const closed = once(client.ws, 'close');
  client.subscribe();
  expect((await closed)[0]).toBe(1008);
  expect(client.messages.map((message) => message.type)).toEqual(['refused']);
});
it('refuses a joined SQL member when OpenFGA has removed permission', async () => {
  const removed = parseEventByType(event('permission-removed', 'member-alice', 'member.removed'));
  if (!removed.success) throw new Error('Invalid fixture');
  await authz.handler.handle(removed.event, pgDb(dbs.queue));
  const client = await connect();
  const closed = once(client.ws, 'close');
  client.subscribe();
  expect((await closed)[0]).toBe(1008);
  expect(client.messages.map((message) => message.type)).toEqual(['refused']);
});
it('replays, streams committed changes, and reconnects without gaps or duplicate members', async () => {
  const client = await connect();
  client.subscribe();
  await until(() => client.messages.some((message) => message.type === 'ready'));
  expect(client.messages.filter((message) => message.type === 'member').map((message) => message.position)).toEqual([1, 2]);
  await append('bob');
  await until(() => client.messages.some((message) => message.position === 3));
  const closed = once(client.ws, 'close');
  client.ws.close();
  await closed;
  await append('carol');
  const resumed = await connect();
  resumed.subscribe(3);
  // A commit racing with the initial read must appear exactly once.
  await append('dan');
  await until(() => resumed.messages.some((message) => message.position === 5));
  expect(resumed.messages.filter((message) => message.type === 'member').map((message) => message.position)).toEqual([4, 5]);
  expect(resumed.messages.filter((message) => message.type === 'member').map((message) => message.member.memberId)).toEqual(['carol', 'dan']);
});
it('keeps uncommitted and rolled-back rows off the socket', async () => {
  const client = await connect();
  client.subscribe(2);
  await until(() => client.messages.some((message) => message.type === 'ready'));
  await append('bob', 'member.joined', {}, false);
  let release: () => void = () => { throw new Error('No transaction'); };
  const held = new Promise<void>((resolve) => { release = resolve; });
  let applied = false;
  const run = runner.run({ ...members, async apply(tx, event, position) {
    await members.apply(tx, event, position);
    applied = true;
    await held;
    throw new Error('rollback probe');
  } });
  const rejected = expect(run).rejects.toThrow('rollback probe');
  await until(() => applied);
  await delay(1100); // Includes a permission poll while the transaction is open.
  expect(client.messages.filter((message) => message.type === 'member')).toHaveLength(0);
  release();
  await rejected;
  expect((await dbs.queue.query('SELECT * FROM member_changes WHERE position = 3')).rows).toHaveLength(0);
  await runner.run(members);
  await until(() => client.messages.some((message) => message.position === 3));
});
it('fails closed when OpenFGA is unavailable, and closes an existing socket on removal', async () => {
  const client = await connect();
  client.subscribe();
  await until(() => client.messages.some((message) => message.type === 'ready'));
  const removed = once(client.ws, 'close');
  await append('alice', 'member.removed');
  expect((await removed)[0]).toBe(1008);
  await fga.pause();
  try {
    // Restore the SQL identity from events so this exercises the actual unavailable check.
    await append('alice', 'member.invited', { invitationId: 'again', invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-alice' } });
    const raw = event(`realtime-${++sequence}`, 'member-alice');
    await nats.store.append({ expectedSequence: 4, event: { ...raw, principal: { kind: 'human', id: 'oidc-alice' }, data: { ...raw.data, invitationId: 'again' } } });
    await runner.run(members);
    const refused = await connect();
    const closed = once(refused.ws, 'close');
    refused.subscribe();
    expect((await closed)[0]).toBe(1008);
  } finally { await fga.resume(); }
}, 15_000);
it('limits each connection to 20 messages per second', async () => {
  const client = await connect();
  // Malformed application messages consume the same rate budget.
  client.ws.removeAllListeners('message');
  const closed = once(client.ws, 'close');
  for (let i = 0; i < 21; i++) client.ws.send('{');
  expect((await closed)[0]).toBe(1008);
});
it('drops live deltas for a paused consumer and replays every missing position on reconnect', async () => {
  const changeCount = 64;
  const client = await connect();
  client.subscribe(2);
  await until(() => client.messages.some((message) => message.type === 'ready'));
  client.ws.pause();
  // Real TCP backpressure: exceed the kernel receive window, with no socket mocks.
  for (let i = 0; i < changeCount; i++) await append(`slow-${i}`, 'member.joined', { displayName: 'x'.repeat(64_000) }, false);
  await runner.run(members);
  await delay(300);
  const closed = once(client.ws, 'close');
  client.ws.resume();
  expect((await closed)[0]).toBe(1013);
  expect(client.messages.some((message) => message.type === 'resync')).toBe(true);
  const received = client.messages.filter((message) => message.type === 'member').map((message) => message.position);
  const last = received.at(-1) ?? 2;
  expect(last).toBeLessThan(changeCount + 2);
  const resumed = await connect();
  resumed.subscribe(last);
  await until(() => resumed.messages.some((message) => message.type === 'ready'), 15_000);
  const replayed = resumed.messages.filter((message) => message.type === 'member').map((message) => message.position);
  expect([...received, ...replayed]).toEqual(Array.from({ length: changeCount }, (_, i) => i + 3));
}, 30_000);
it('terminates a peer that does not answer heartbeats', async () => {
  const client = await connect('oidc-alice', 'org-acme', false);
  const closed = once(client.ws, 'close');
  expect((await closed)[0]).toBe(1006);
}, 35_000);
