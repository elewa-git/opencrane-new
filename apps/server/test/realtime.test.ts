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
import { groups, members, pgDb, ProjectionRunner, rebuildMemberProjection, type EventSource } from '@opencrane/projections';
import { memberDirectorySchema, memberDetailSchema, realtimeMessageSchema, type RealtimeMessage } from '@opencrane/protocol';
import { startServer, TEST_OIDC_ENV, type RunningServer } from './support/process.ts';

const env = { ...TEST_OIDC_ENV, OIDC_EXPECTED_ORG_ID: 'org-acme', SILO_ID: 'test',
  // The owner signs in from their own organisation and is allowed by name.
  OIDC_EXTRA_IDENTITIES: JSON.stringify([{ issuer: TEST_OIDC_ENV.OIDC_ISSUER_URL, subject: 'oidc-owner' }]) };
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
  await runner.initialise(groups);
  authz = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  await append('alice', 'member.invited', { invitationId: 'invite-alice',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-alice' } });
  await append('alice', 'member.joined', { invitationId: 'invite-alice', role: 'admin' });
  const binding = authz.binding;
  server = await startServer({ ...env, ...nats.env(), DATABASE_URL: dbs.queue.options.connectionString,
    OPENFGA_API_URL: binding.apiUrl, OPENFGA_STORE_ID: binding.storeId, OPENFGA_MODEL_ID: binding.authorizationModelId });
// Fixture setup includes certificates, PostgreSQL and a real server process.
}, 60_000);
afterEach(async () => {
  try {
    await Promise.all(sockets.splice(0).map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, 'close');
      socket.terminate();
      await closed;
    }));
  } finally {
    try { await server?.stop(); }
    finally {
      try { await nats?.close(); }
      finally { await dbs?.close(); }
    }
  }
});
async function append(id: string, type = 'member.joined', data = {}, project = true, iam = true) {
  const raw = event(`realtime-${++sequence}`, `member-${id}`, type);
  const parsed = parseEventByType({ ...raw, principal: { kind: 'human', id: `oidc-${id}` }, data: { ...raw.data, ...data } });
  if (!parsed.success) throw new Error('Invalid fixture');
  let expectedSequence = 0;
  for await (const stored of nats.store.readStream(raw.subject)) expectedSequence = stored.sequence;
  const result = await nats.store.append({ expectedSequence, event: parsed.event });
  expect(result.status).toBe('appended');
  if (iam && type !== 'member.invited') await authz.handler.handle(parsed.event, pgDb(dbs.queue));
  if (project) {
    await runner.run(members);
    await runner.run(groups);
  }
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
  return { ws, messages, subscribe(since = 0, generation = since > 0 ? 0 : undefined) {
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'members', since, ...(generation === undefined ? {} : { generation }) }));
  } };
}

it.each(['cookie', 'origin', 'missing-origin', 'organisation'])('refuses an upgrade with bad %s in the real process', async (kind) => {
  const h: Record<string, string> = kind === 'organisation' ? headers('oidc-alice', 'other') : headers();
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
it.each([['unknown', 'org-acme'], ['alice', 'org-acme']])('refuses identity %s in organisation %s regardless of cookie roles', async (sub, org) => {
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
  // Include an event saved during the initial read exactly once.
  await append('dan');
  await until(() => resumed.messages.some((message) => message.position === 5));
  expect(resumed.messages.filter((message) => message.type === 'member').map((message) => message.position)).toEqual([4, 5]);
  expect(resumed.messages.filter((message) => message.type === 'member').map((message) => message.member.memberId)).toEqual(['carol', 'dan']);
});
it('keeps a subscriber live while replay catches an arriving event and switches tables', async () => {
  const client = await connect();
  client.subscribe(2);
  await until(() => client.messages.some((message) => message.type === 'ready'));
  let appended = false;
  const arriving: EventSource = {
    head: () => nats.reader.head(),
    async *subscribe(fromSequence, signal) {
      for await (const stored of nats.reader.subscribe(fromSequence, signal)) {
        yield stored;
        if (!appended) {
          appended = true;
          await append('carol', 'member.joined', {}, false);
        }
      }
    },
  };
  const result = await rebuildMemberProjection(
    pgDb(dbs.queue),
    arriving,
    createLogger('realtime-rebuild'),
    { verify: true },
  );
  expect(result).toMatchObject({ previousSequence: 2, sequence: 3, verified: true, changed: false });
  await until(() => client.messages.some((message) => message.position === 3));
  await append('dan');
  await until(() => client.messages.some((message) => message.position === 4));
  expect(client.ws.readyState).toBe(WebSocket.OPEN);
  expect(client.messages.filter((message) => message.type === 'member').map((message) => message.member.memberId))
    .toEqual(['carol', 'dan']);
});
it('resets live and resumed clients after replay repairs delivered state', async () => {
  await dbs.queue.query("UPDATE members SET display_name = 'Wrong' WHERE member_id = 'alice'");
  await dbs.queue.query("UPDATE member_changes SET member = jsonb_set(member, '{displayName}', '\"Wrong\"') WHERE position = 2");
  const client = await connect();
  client.subscribe();
  await until(() => client.messages.some((message) => message.type === 'ready'));
  expect(client.messages.find((message) => message.type === 'member' && message.position === 2))
    .toMatchObject({ member: { displayName: 'Wrong' }, generation: 0 });

  const closed = once(client.ws, 'close');
  const result = await rebuildMemberProjection(pgDb(dbs.queue), nats.reader, createLogger('repair-rebuild'));
  expect(result).toMatchObject({ changed: true, previousSequence: 2, sequence: 2 });
  await until(() => client.messages.some((message) => message.type === 'resync'));
  expect(client.messages.at(-1)).toMatchObject({ type: 'resync', position: 0, generation: 1 });
  expect((await closed)[0]).toBe(1013);

  const corrected = await connect();
  corrected.subscribe(0, 1);
  await until(() => corrected.messages.some((message) => message.type === 'ready'));
  expect(corrected.messages.find((message) => message.type === 'member' && message.position === 2))
    .toMatchObject({ member: { displayName: 'Alice' }, generation: 1 });

  const stale = await connect();
  const staleClosed = once(stale.ws, 'close');
  stale.subscribe(2, 0);
  expect((await staleClosed)[0]).toBe(1013);
  expect(stale.messages).toEqual([expect.objectContaining({ type: 'resync', position: 0, generation: 1 })]);
}, 15_000);
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
    await nats.store.append({ expectedSequence: 4, event: { ...raw, principal: { kind: 'human', id: 'oidc-alice' }, data: { ...raw.data, role: 'admin', invitationId: 'again' } } });
    await runner.run(members);
    const refused = await connect();
    const closed = once(refused.ws, 'close');
    refused.subscribe();
    expect((await closed)[0]).toBe(1011);
  } finally { await fga.resume(); }
}, 15_000);
it('limits each connection to 20 messages per second', async () => {
  const client = await connect();
  // Count malformed messages against the same rate limit.
  client.ws.removeAllListeners('message');
  const closed = once(client.ws, 'close');
  for (let i = 0; i < 21; i++) client.ws.send('{');
  expect((await closed)[0]).toBe(1008);
});
it('drops live deltas for a paused consumer and replays every missing position on reconnect', async () => {
  let changeCount = 0;
  const client = await connect();
  client.subscribe(2);
  await until(() => client.messages.some((message) => message.type === 'ready'));
  client.ws.pause();
  const backpressured = () => server.stdout().includes('member subscriber needs resync');
  // TCP buffer sizes vary by host. Send batches until the server drops an update.
  // Stop at 16 MB so a broken backpressure check fails without unbounded memory use.
  while (!backpressured() && changeCount < 256) {
    for (let i = 0; i < 32; i++) {
      await append(`slow-${changeCount++}`, 'member.joined', { displayName: 'x'.repeat(64_000) }, false);
    }
    await runner.run(members);
  }
  await until(backpressured);
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
// Allow 15 seconds for reconnecting, plus time to fill TCP buffers and save
// large rows on a busy machine.
}, 60_000);
it('terminates a peer that does not answer heartbeats', async () => {
  const client = await connect('oidc-alice', 'org-acme', false);
  const closed = once(client.ws, 'close');
  expect((await closed)[0]).toBe(1006);
}, 35_000);

async function refusesStaleAuthority(change: 'member.role_changed' | 'member.removed') {
  await append('bob');
  let data = {};
  if (change === 'member.role_changed') {
    data = { previousRole: 'admin', newRole: 'member', changedBy: 'owner' };
  }
  await append('alice', change, data, false, false);
  expect((await authz.check('alice', 'admin')).allowed).toBe(true);
  const client = await connect();
  const closed = once(client.ws, 'close');
  client.subscribe();
  await until(() => client.messages.length > 0);
  expect(client.messages).toEqual([expect.objectContaining({ type: 'refused' })]);
  expect((await closed)[0]).toBe(1008);
  const directory = await memberRead('/api/members');
  expect(directory.status).toBe(403);
  expect(await directory.json()).toEqual({ status: 'refused' });
  if (change === 'member.removed') {
    const header = await memberRead('/api/members/bob');
    expect(header.status).toBe(403);
    expect(await header.json()).toEqual({ status: 'refused' });
  }
}
it.each(['member.role_changed', 'member.removed'] as const)(
  'sends no protected records after %s while SQL and IAM still grant admin',
  refusesStaleAuthority,
);

it('refuses member reads when OpenFGA has revoked access but membership events are current', async () => {
  const removed = parseEventByType(event('permission-removed-http', 'member-alice', 'member.removed'));
  if (!removed.success) throw new Error('Invalid fixture');
  await authz.handler.handle(removed.event, pgDb(dbs.queue));

  const directory = await memberRead('/api/members');
  expect(directory.status).toBe(403);
  expect(await directory.json()).toEqual({ status: 'refused' });
  const header = await memberRead('/api/members/bob');
  expect(header.status).toBe(403);
  expect(await header.json()).toEqual({ status: 'refused' });
});

it('admits the allowed owner from another organisation to member reads and the live feed', async () => {
  await append('owner', 'member.invited', { invitationId: 'invite-owner',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-owner' } });
  await append('owner', 'member.joined', { invitationId: 'invite-owner', role: 'owner' });
  const directory = await fetch(`http://127.0.0.1:${server.port}/api/members`,
    { headers: headers('oidc-owner', 'org-owner-home') });
  expect(directory.status).toBe(200);
  const client = await connect('oidc-owner', 'org-owner-home');
  client.subscribe();
  await until(() => client.messages.some((message) => message.type === 'ready'));
  expect(client.messages.map((message) => message.type)).not.toContain('refused');
});

it('refuses member reads from a different organisation', async () => {
  const directory = await fetch(`http://127.0.0.1:${server.port}/api/members`,
    { headers: headers('oidc-alice', 'other') });
  expect(directory.status).toBe(403);
  expect(await directory.json()).toEqual({ status: 'refused' });
  const header = await fetch(`http://127.0.0.1:${server.port}/api/members/bob`,
    { headers: headers('oidc-alice', 'other') });
  expect(header.status).toBe(403);
  expect(await header.json()).toEqual({ status: 'refused' });
});

it('returns not found for removed and pending member headers', async () => {
  await append('bob', 'member.invited', { invitationId: 'invite-bob',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-bob' } });
  await append('bob', 'member.joined', { invitationId: 'invite-bob' });
  await append('bob', 'member.removed');
  await append('pending', 'member.invited', { invitationId: 'invite-pending' });
  await append('carol', 'member.invited', { invitationId: 'invite-carol',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-carol' } });
  await append('carol', 'member.joined', { invitationId: 'invite-carol' });

  const removed = await memberRead('/api/members/bob', 'oidc-carol');
  expect(removed.status).toBe(404);
  expect(await removed.json()).toEqual({ status: 'not_found' });
  const pending = await memberRead('/api/members/pending', 'oidc-carol');
  expect(pending.status).toBe(404);
  expect(await pending.json()).toEqual({ status: 'not_found' });
});

it('returns unavailable when a stored membership event has an invalid role', async () => {
  const malformed = event('malformed-member-role', 'member-bob', 'member.joined');
  const invalidMembership = { ...malformed,
    data: { ...malformed.data, role: 42 } };
  await nats.seed([invalidMembership]);

  const response = await memberRead('/api/members/bob');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: 'unavailable' });
});

async function refusesOrdinaryMember() {
  await append('bob', 'member.invited', { invitationId: 'invite-bob',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-bob' } });
  await append('bob', 'member.joined', { invitationId: 'invite-bob' });
  const client = await connect('oidc-bob');
  const closed = once(client.ws, 'close');
  client.subscribe();
  await until(() => client.messages.length > 0);
  expect(client.messages).toEqual([expect.objectContaining({ type: 'refused' })]);
  expect((await closed)[0]).toBe(1008);
}
it('sends no member email, name, role or status to a Member with an owner cookie',
  refusesOrdinaryMember);

async function memberRead(path: string, sub = 'oidc-alice') {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { headers: headers(sub) });
}
async function readsMinimalHeader() {
  await append('bob', 'member.invited', { invitationId: 'invite-bob',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-bob' } });
  await append('bob', 'member.joined', { invitationId: 'invite-bob' });
  const before = await nats.store.head();
  const response = await memberRead('/api/members/alice', 'oidc-bob');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ memberId: 'alice', displayName: 'Alice', role: 'admin',
    permissions: { changeRole: false, remove: false, manageOwnership: false } });
  const directory = await memberRead('/api/members', 'oidc-bob');
  expect(directory.status).toBe(403);
  expect(await directory.json()).toEqual({ status: 'refused' });
  expect(await nats.store.head()).toBe(before);
}
it('gives a Member only the header and false management flags, never the directory',
  readsMinimalHeader);

async function readsBoundedDirectory() {
  await append('pending', 'member.invited', { expiresAt: '2099-01-01T00:00:00Z' });
  await append('pending', 'member.invited', { invitationId: 'latest',
    expiresAt: '2099-01-01T00:00:00Z' });
  await append('expired', 'member.invited', { expiresAt: new Date().toISOString() });
  await append('bob', 'member.joined', { email: 'bob@example.test' });
  await append('carol', 'member.joined', { email: 'carol@example.test' });
  const before = await nats.store.head();
  const response = await memberRead('/api/members?after=&limit=1');
  expect(response.status).toBe(200);
  const page = memberDirectorySchema.parse(await response.json());
  expect(page).toMatchObject({ rows: [{ memberId: 'alice', role: 'admin', groups: [] }],
    next: 'alice', counts: { members: { status: 'current', value: 3 },
      pendingInvitations: { status: 'current', value: 1 },
      acceptedInvitations: { status: 'current', value: 1 } } });
  const detailResponse = await memberRead('/api/members/alice');
  const detail = memberDetailSchema.parse(await detailResponse.json());
  expect(detail).toMatchObject({ email: 'alice@example.com', role: 'admin',
    joinedAt: '2026-10-01T00:00:00Z', personalAssistant: { status: 'unavailable' } });
  const next = await memberRead('/api/members?after=alice&limit=1');
  expect(await next.json()).toMatchObject({ rows: [{ memberId: 'bob' }], next: 'bob' });
  const searched = await memberRead('/api/members?q=alice%40example.com');
  expect(await searched.json()).toMatchObject({ rows: [{ memberId: 'alice' }], next: null });
  for (const query of ['limit=51', 'q=' + 'x'.repeat(101), 'after=*']) {
    expect((await memberRead('/api/members?' + query)).status).toBe(400);
  }
  await append('bob', 'member.removed', {}, false, false);
  const delayed = await memberRead('/api/members');
  expect(await delayed.json()).toMatchObject({ rows: [
    { memberId: 'alice' }, { memberId: 'carol' },
  ], counts: { members: { status: 'applying', value: null } },
  projection: { content: 'applying' } });
  expect(await nats.store.head()).toBe(before + 1);
}
it('pages the member projection, searches contact email and never calls page length a total',
  readsBoundedDirectory);

async function closesWithDelayedContent(change: 'member.role_changed' | 'member.removed') {
  const client = await connect();
  client.subscribe();
  await until(() => client.messages.some(isReady));
  const connection = await dbs.queue.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('LOCK TABLE member_changes IN ACCESS EXCLUSIVE MODE');
    await delay(300);
    let data = {};
    if (change === 'member.role_changed') {
      data = { previousRole: 'admin', newRole: 'member', changedBy: 'owner' };
    }
    await append('alice', change, data, false, false);
    const recordedAt = performance.now();
    await until(() => client.ws.readyState === WebSocket.CLOSED, 2100);
    expect(performance.now() - recordedAt).toBeLessThanOrEqual(2000);
    expect(client.messages.at(-1)?.type).toBe('refused');
    expect(client.messages.filter(isMember)).toHaveLength(2);
  } finally {
    await connection.query('ROLLBACK');
    connection.release();
  }
}
function isReady(message: RealtimeMessage) {
  return message.type === 'ready';
}
function isMember(message: RealtimeMessage) {
  return message.type === 'member';
}
it.each(['member.role_changed', 'member.removed'] as const)(
  'closes within two seconds of %s while SQL content and IAM are delayed',
  closesWithDelayedContent,
);

async function countsUnavailableBeyondBound() {
  const records = [];
  for (let index = 0; index < 500; index++) {
    records.push(event(`bounded-${index}`, `member-counted-${index}`, 'member.joined'));
  }
  await nats.seed(records);
  await runner.run(members);
  await runner.run(groups);
  const response = await memberRead('/api/members?limit=1');
  expect(response.status).toBe(200);
  const directory = memberDirectorySchema.parse(await response.json());
  expect(directory.counts.members).toEqual({ status: 'unavailable', value: null });
  expect(directory.rows).toHaveLength(1);
}
it('marks totals unavailable when member history exceeds the read budget',
  countsUnavailableBeyondBound, 120_000);

async function expiresHungAuthority() {
  const client = await connect();
  client.subscribe();
  await until(() => client.messages.some(isReady));
  nats.pauseResponses(true);
  const started = performance.now();
  try {
    await until(() => client.ws.readyState === WebSocket.CLOSED, 2100);
    expect(performance.now() - started).toBeLessThanOrEqual(2000);
    expect(client.messages.filter(isMember)).toHaveLength(2);
  } finally {
    nats.pauseResponses(false);
  }
  await delay(300);
  expect(client.ws.readyState).toBe(WebSocket.CLOSED);
  expect(client.messages.filter(isMember)).toHaveLength(2);
}
it('closes on an event-store outage and keeps late transport replies off the socket',
  expiresHungAuthority);
