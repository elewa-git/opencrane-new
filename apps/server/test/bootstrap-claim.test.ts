import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeSession, type SessionData } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const session: SessionData = { sub: 'alice', orgId: 'org-acme', roles: [], authTime: 0, exp: 2_000_000_000 };
let nats: Awaited<ReturnType<typeof natsFixture>>;
let directory: string, path: string, token: string;
let app: ReturnType<typeof buildServer>;
let clock: Date;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'claim-'));
  path = join(directory, 'token.json');
  const generated = spawnSync(process.execPath, ['--experimental-strip-types', resolve('apps/server/src/bootstrap-token.ts')], {
    env: { ...process.env, BOOTSTRAP_TOKEN_FILE: path, SILO_ID: 'test' }, encoding: 'utf8',
  });
  expect(generated.status, generated.stderr).toBe(0);
  token = generated.stdout.trim(); clock = new Date();
  nats = await natsFixture();
  // The process entrypoint uses this same deployment-owned path.
  process.env['BOOTSTRAP_TOKEN_FILE'] = path;
  app = buildServer(config, { membership: { silo: 'test', store: nats.store, now: () => clock } });
});
afterEach(async () => {
  delete process.env['BOOTSTRAP_TOKEN_FILE'];
  await app?.close(); await nats?.close(); await rm(directory, { recursive: true, force: true });
});
function claim(identity = session, presented = token) {
  return app.inject({ method: 'POST', url: '/api/silo/claim', payload: { token: presented, displayName: 'Alice', email: 'alice@example.test' },
    headers: { origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(config, identity)}` } });
}

it('claims the first owner with one durable event and no token in history', async () => {
  const response = await claim();
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({ status: 'claimed', memberId: 'bootstrap-owner' });
  const rows = [];
  for await (const row of nats.store.readStream('member-*')) rows.push(row);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event).toMatchObject({ type: 'silo.owner_bootstrapped', subject: 'member-bootstrap-owner', silo: 'test',
    principal: { kind: 'human', id: 'alice' }, data: { memberId: 'bootstrap-owner', role: 'owner', identity: { issuer: config.issuerUrl, sub: 'alice' } } });
  expect(JSON.stringify(rows)).not.toContain(token);
});

it.each([
  ['wrong_token', 'wrong', 0],
  ['token_expired', undefined, 86_400_000],
] as const)('refuses %s without an event', async (reason, presented, elapsed) => {
  clock = new Date(clock.getTime() + elapsed);
  const response = await claim(session, presented ?? token);
  expect(response.json()).toEqual({ status: 'refused', reason });
  expect(await nats.store.head()).toBe(0);
});

it('refuses reuse after a restart, including after removal of the bootstrap owner', async () => {
  expect((await claim()).statusCode).toBe(201);
  await nats.stop(); await nats.restart();
  await app.close();
  app = buildServer(config, { membership: { silo: 'test', store: nats.store, now: () => clock } });
  expect((await claim()).json()).toEqual({ status: 'refused', reason: 'token_used' });
  expect((await claim({ ...session, sub: 'bob' })).json()).toEqual({ status: 'refused', reason: 'owner_exists' });
  const { event } = await import('@opencrane/event-store/testing');
  await nats.store.append({ expectedSequence: 1, event: { ...event('remove', 'member-bootstrap-owner', 'member.removed'),
    silo: 'test', data: { memberId: 'bootstrap-owner', removedBy: 'admin' } } });
  expect((await claim()).json()).toEqual({ status: 'refused', reason: 'token_used' });
  expect(await nats.store.head()).toBe(2);
});

it('refuses an existing owner even when that member came through the dev invitation path', async () => {
  const { event } = await import('@opencrane/event-store/testing');
  expect((await nats.store.append({ expectedSequence: 0, event: { ...event('dev-owner', 'member-jente', 'member.joined'),
    silo: 'test', data: { memberId: 'jente', email: 'jente@example.test', displayName: 'Jente', role: 'owner' } } })).status).toBe('appended');
  expect((await claim()).json()).toEqual({ status: 'refused', reason: 'owner_exists' });
  expect(await nats.store.head()).toBe(1);
});

it('refuses an existing non-owner member without changing their identity binding or role', async () => {
  const { event } = await import('@opencrane/event-store/testing');
  const { databases } = await import('@opencrane/authz/testing');
  const { connectMemberFeed, members, pgDb, ProjectionRunner } = await import('@opencrane/projections');
  const { createLogger } = await import('@opencrane/observability');
  const dbs = await databases();
  const feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  const runner = new ProjectionRunner(pgDb(dbs.queue), nats.store, createLogger('bootstrap-test', { level: 'silent' }));
  try {
    await runner.initialise(members);
    expect((await nats.store.append({ expectedSequence: 0, event: {
      ...event('invite-alice', 'member-alice', 'member.invited'), silo: 'test',
      data: { memberId: 'alice', invitationId: 'invite-alice', email: 'alice@example.test', role: 'member',
        invitedBy: 'admin', invitedIdentity: { issuer: config.issuerUrl, sub: session.sub },
        expiresAt: new Date(clock.getTime() + 60_000).toISOString() },
    } })).status).toBe('appended');
    const joined = await app.inject({ method: 'POST', url: '/members/join',
      payload: { memberId: 'alice', invitationId: 'invite-alice', commandId: 'join-alice', displayName: 'Alice' },
      headers: { origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(config, session)}` } });
    expect(joined.statusCode).toBe(200);
    await runner.run(members);
    expect(await feed.memberId('test', config.issuerUrl, session.sub)).toBe('alice');
    const original = [{ position: 1, member: { memberId: 'alice', email: 'alice@example.test', displayName: null,
      role: 'member', status: 'invited' } }, { position: 2, member: { memberId: 'alice', email: 'alice@example.test',
      displayName: 'Alice', role: 'member', status: 'joined' } }];
    expect(await feed.read('test', 0)).toEqual(original);
    const response = await claim();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', reason: 'members_exist' });
    expect(await nats.store.head()).toBe(2);
    await runner.run(members);
    expect(await feed.memberId('test', config.issuerUrl, session.sub)).toBe('alice');
    expect(await feed.read('test', 0)).toEqual(original);
    await runner.rebuild(members);
    expect(await feed.memberId('test', config.issuerUrl, session.sub)).toBe('alice');
    expect(await feed.read('test', 0)).toEqual(original);
  } finally { await feed.close(); await dbs.close(); }
});

it('refuses another organisation even when the dev identity exception allows it to sign in', async () => {
  await app.close();
  const exceptional = { ...config, extraIdentities: [{ issuer: config.issuerUrl, subject: session.sub }] };
  app = buildServer(exceptional, { membership: { silo: 'test', store: nats.store, now: () => clock } });
  expect((await claim({ ...session, orgId: 'elsewhere' })).json()).toEqual({ status: 'refused', reason: 'wrong_organisation' });
  expect(await nats.store.head()).toBe(0);
});

it('allows exactly one winner across two HTTP servers racing the same token', async () => {
  const other = buildServer(config, { membership: { silo: 'test', store: nats.store, now: () => clock } });
  try {
    const responses = await Promise.all([claim(), other.inject({ method: 'POST', url: '/api/silo/claim',
      payload: { token, displayName: 'Bob', email: 'bob@example.test' }, headers: { origin: 'https://app.example.test',
        cookie: `${config.cookieName}=${encodeSession(config, { ...session, sub: 'bob' })}` } })]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect(await nats.store.head()).toBe(1);
  } finally { await other.close(); }
});

it.each(['alice', 'bob'])('refuses a claim by %s when a member binds after the history read', async sub => {
  const { event } = await import('@opencrane/event-store/testing');
  let reachedAppend!: () => void, resumeAppend!: () => void;
  const reached = new Promise<void>(resolve => { reachedAppend = resolve; });
  const resume = new Promise<void>(resolve => { resumeAppend = resolve; });
  await app.close();
  app = buildServer(config, { membership: { silo: 'test', now: () => clock, store: {
    readStream: (...args) => nats.store.readStream(...args),
    async append(command) {
      reachedAppend();
      await resume;
      return nats.store.append(command);
    },
  } } });
  const claiming = claim({ ...session, sub }).then(response => response);
  try {
    await reached;
    expect((await nats.store.append({ expectedSequence: 0, event: {
      ...event('invite-racing-alice', 'member-alice', 'member.invited'), silo: 'test',
      data: { memberId: 'alice', invitationId: 'invite-alice', email: 'alice@example.test', role: 'member',
        invitedBy: 'admin', invitedIdentity: { issuer: config.issuerUrl, sub: session.sub },
        expiresAt: new Date(clock.getTime() + 60_000).toISOString() },
    } })).status).toBe('appended');
    expect((await nats.store.append({ expectedSequence: 1, event: {
      ...event('join-racing-alice', 'member-alice', 'member.joined'), silo: 'test',
      principal: { kind: 'human', id: session.sub },
      data: { memberId: 'alice', invitationId: 'invite-alice', email: 'alice@example.test',
        displayName: 'Alice', role: 'member' },
    } })).status).toBe('appended');
  } finally { resumeAppend(); }
  const response = await claiming;
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused', reason: 'concurrent_claim' });
  expect(await nats.store.head()).toBe(2);
  const bootstrap = [];
  for await (const row of nats.store.readStream('member-bootstrap-owner')) bootstrap.push(row);
  expect(bootstrap).toEqual([]);
  expect((await claim()).json()).toEqual({ status: 'refused', reason: 'members_exist' });
});

it('limits failed guesses across authenticated identities and allows attempts after one minute', async () => {
  for (let i = 0; i < 5; i++) expect((await claim({ ...session, sub: `guesser-${i}` }, 'wrong')).statusCode).toBe(409);
  const blocked = await claim();
  expect(blocked.statusCode).toBe(429);
  expect(blocked.headers['retry-after']).toBe('60');
  expect(await nats.store.head()).toBe(0);
  clock = new Date(clock.getTime() + 60_000);
  expect((await claim()).statusCode).toBe(201);
});

it.each([undefined, 'https://evil.example.test'])('requires a same-origin authenticated claim (origin: %s)', async origin => {
  const response = await app.inject({ method: 'POST', url: '/api/silo/claim', payload: { token },
    headers: { cookie: `${config.cookieName}=${encodeSession(config, session)}`, ...(origin ? { origin } : {}) } });
  expect(response.statusCode).toBe(403);
  expect(await nats.store.head()).toBe(0);
});
it('requires a session and rejects body authority and invalid contact data', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/silo/claim', payload: { token } })).statusCode).toBe(401);
  for (const extra of [{ role: 'owner' }, { memberId: 'mallory' }, { email: 'invalid' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/silo/claim',
      payload: { token, displayName: 'Alice', email: 'alice@example.test', ...extra }, headers: {
        origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(config, session)}` } });
    expect(response.statusCode).toBe(400);
  }
  expect(await nats.store.head()).toBe(0);
});

it('projects and replays the owner identity and OpenFGA role, assistant and model grants', async () => {
  const { databases, openfga } = await import('@opencrane/authz/testing');
  const { createStore, memberAuthorisation, rebuildMembers } = await import('@opencrane/authz');
  const { connectMemberFeed, members, pgDb, ProjectionRunner } = await import('@opencrane/projections');
  const { BudgetActor, modelGrantHandler, models } = await import('@opencrane/models');
  const { lifecycleHandlers } = await import('../../ops/src/lifecycle.ts');
  const { createLogger } = await import('@opencrane/observability');
  const dbs = await databases(), fga = await openfga();
  const db = pgDb(dbs.queue);
  const feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  const runner = new ProjectionRunner(db, nats.store, createLogger('bootstrap-test', { level: 'silent' }));
  try {
    await runner.initialise(members);
    expect((await claim()).statusCode).toBe(201);
    const rows = [];
    for await (const row of nats.store.readStream('member-bootstrap-owner')) rows.push(row);
    const trigger = rows[0]!.event;
    await runner.run(members);
    expect(await feed.memberId('test', config.issuerUrl, 'alice')).toBe('bootstrap-owner');
    expect(await feed.memberId('test', config.issuerUrl, 'bob')).toBeUndefined();
    await runner.rebuild(members);
    expect(await feed.memberId('test', config.issuerUrl, 'alice')).toBe('bootstrap-owner');
    const binding = await createStore(fga.apiUrl, 'test'), auth = memberAuthorisation(binding);
    await auth.handler.handle(trigger, db);
    expect((await auth.check('bootstrap-owner', 'owner')).allowed).toBe(true);
    expect((await auth.check('bootstrap-owner', 'admin')).allowed).toBe(true);
    const assistant = lifecycleHandlers(nats.store)[0];
    await assistant.handle(trigger, db); await assistant.handle(trigger, db);
    await modelGrantHandler(nats.store).handle(trigger, db);
    await modelGrantHandler(nats.store).handle(trigger, db);
    const assistants = [];
    for await (const { event } of nats.store.readStream('assistant-*')) {
      assistants.push(event);
      await auth.handler.handle(event, db);
      await modelGrantHandler(nats.store).handle(event, db);
    }
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.data).toMatchObject({ kind: 'personal', ownerId: 'bootstrap-owner' });
    for await (const { event } of nats.store.readStream('grant-*')) await auth.handler.handle(event, db);
    for (const model of models.filter(m => !m.retired)) {
      expect((await auth.use('person', 'bootstrap-owner', 'model', model.id)).allowed).toBe(true);
    }
    const replay = await rebuildMembers(fga.apiUrl, 'test', nats.store, { verifyAgainst: binding });
    expect((await replay.check('bootstrap-owner', 'owner')).allowed).toBe(true);
    const budget = new BudgetActor(nats.store, 'test');
    await budget.start(2000, 20000, 'installation-default');
    expect(budget.state.defaultPayingGroupId).toBe('installation-default');
  } finally { await feed.close(); await dbs.close(); await fga.close(); }
}, 60_000);

it('keeps tokens out of success, refusal, malformed-body and dependency-error logs', async () => {
  const { vi } = await import('vitest');
  vi.stubEnv('LOG_LEVEL', 'info');
  let logs = '';
  await app.close();
  app = buildServer(config, { membership: { silo: 'test', store: nats.store, now: () => clock },
    logDestination: { write: (message: string) => { logs += message; } } });
  try {
    await app.inject({ method: 'POST', url: '/api/silo/claim', payload: `{"token":"${token}"`, headers: {
      'content-type': 'application/json', origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(config, session)}` } });
    expect(logs).not.toContain(token);
    await claim(session, `${token}wrong`);
    expect(logs).not.toContain(token);
    const { chmod } = await import('node:fs/promises');
    await chmod(path, 0o644);
    expect((await claim()).statusCode).toBe(503);
    expect(logs).not.toContain(token);
    await chmod(path, 0o600);
    await claim();
    expect(logs).not.toContain(token);
    await claim();
    expect(logs).not.toContain(token);
  } finally { vi.unstubAllEnvs(); }
});

it('fails closed on unsafe secret-file permissions or a missing file without writing events', async () => {
  const { chmod, unlink } = await import('node:fs/promises');
  await chmod(path, 0o644);
  expect((await claim()).statusCode).toBe(503);
  await unlink(path);
  expect((await claim()).statusCode).toBe(503);
  expect(await nats.store.head()).toBe(0);
});

it('reports an unavailable event store and admits a safe retry after it recovers', async () => {
  await nats.stop();
  const response = await claim();
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  await nats.restart();
  expect((await claim()).statusCode).toBe(201);
  expect(await nats.store.head()).toBe(1);
}, 45_000);
