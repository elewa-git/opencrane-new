import Fastify, { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition } from '@opencrane/events';
import { envelope, history, writeHostedAdmission, readHostedAdmission, foldHostedAdmission } from '@opencrane/models';
import { emptyToolPolicy, mcpCatalogue, pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { registerIntegrationRoutes } from '../src/integrations/routes.ts';
import { installWorker } from '../src/integrations/install-worker.ts';
import { discoveryStatus } from '../src/integrations/registration.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org-acme' };
const command = { kind: 'hosted', locator: `ghcr.io/elewa/test@sha256:${'a'.repeat(64)}`,
  platform: 'linux/amd64', upstream: { host: 'api.github.com', port: 443 },
  commandId: 'register-image' };
let fga: Awaited<ReturnType<typeof openfga>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let auth: ReturnType<typeof memberAuthorisation>;
let app: FastifyInstance;

async function startFga() {
  fga = await openfga();
}
async function closeFga() {
  await fga.close();
}
beforeAll(startFga, 120_000);
afterAll(closeFga);

async function member(memberId: string, role: 'admin' | 'member') {
  const data = { memberId, role, email: `${memberId}@example.test`,
    displayName: memberId, invitationId: `invite-${memberId}` };
  const event = envelope('test', `member-${memberId}`, 'member.joined', data, memberId);
  expect((await nats.store.append({ event, expectedSequence: 0 })).status).toBe('appended');
  await auth.handler.handle(event, pgDb(dbs.queue));
}

async function setup() {
  nats = await natsFixture();
  dbs = await databases();
  auth = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  await member('alice', 'admin');
  await member('amina', 'admin');
  await member('bob', 'member');
  function memberId(_silo: string, _issuer: string, sub: string) {
    return Promise.resolve(sub);
  }
  function rows() {
    return Promise.resolve([]);
  }
  function tools() {
    return Promise.resolve(emptyToolPolicy());
  }
  app = Fastify();
  const options = { silo: 'test', store: nats.store, binding: auth.binding,
    feed: { memberId }, catalogue: { rows, tools } };
  registerIntegrationRoutes(app, config, options);
}
async function cleanup() {
  vi.restoreAllMocks();
  await app.close();
  await nats.close();
  await dbs.close();
}
beforeEach(setup);
afterEach(cleanup);

function headers(sub = 'alice', origin = new URL(config.redirectUri).origin) {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub, orgId: 'org-acme', roles: ['owner'], authTime: now, exp: now + 60 };
  return { origin, cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
async function register(payload: Record<string, unknown> = command, sub = 'alice', origin?: string) {
  return app.inject({ method: 'POST', url: '/api/org/integrations',
    headers: headers(sub, origin), payload });
}
async function status(commandId: string, sub = 'alice') {
  return app.inject({ method: 'GET', url: `/api/org/integrations/${commandId}/admission`,
    headers: headers(sub) });
}
async function registrations() {
  const rows = [];
  for await (const row of nats.store.readStream('mcp-*')) rows.push(row);
  return rows;
}

const now = new Date();
const digest = 'a'.repeat(64);
const dated = { verdict: 'pass', checkedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), engineVersion: '1',
  reportDigest: digest };
const scanned = { ...dated, databaseDigest: digest, databaseUpdatedAt: now.toISOString() };
function result(serverId: string) {
  return { serverId, attemptId: 1, imageDigest: digest, platform: 'linux/amd64',
    checks: { signature: dated, licence: dated, vulnerability: scanned, malware: scanned } };
}
async function installed() {
  const response = await register();
  expect(response.statusCode).toBe(202);
  return response.json<{ serverId: string }>().serverId;
}
async function savesResultAndReplays() {
  const serverId = await installed();
  expect((await status(serverId)).json()).toMatchObject({ status: 'checking',
    queuedAt: expect.any(String) });
  const payload = result(serverId);
  const append = nats.store.append.bind(nats.store);
  async function lostReply(input: Parameters<typeof append>[0]) {
    await append(input);
    throw new Error('Lost reply');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lostReply);
  await expect(writeHostedAdmission(nats.store, 'test', payload, now)).rejects.toThrow();
  expect((await writeHostedAdmission(nats.store, 'test', payload, now)).status).toBe('appended');
  const changed = { ...payload, checks: { ...payload.checks,
    signature: { ...dated, engineVersion: '2' } } };
  expect((await writeHostedAdmission(nats.store, 'test', changed, now)).status).toBe('conflict');
  const saved = await registrations();
  expect(saved).toHaveLength(2);
  expect(saved[1]?.event).toMatchObject({ type: 'mcp.image_checked', source: 'models',
    principal: { kind: 'system', id: 'models' }, data: payload });
  expect((await status(serverId)).json()).toMatchObject({ status: 'admitted' });
  const expired = new Date(now.getTime() + 3_600_000);
  expect(await readHostedAdmission(nats.store, 'test', serverId, expired))
    .toMatchObject({ status: 'expired' });
  const workerApp = Fastify();
  const resolve = vi.fn();
  try {
    await installWorker(workerApp, nats.store, 'test', { resolve }).discover(serverId);
    expect(resolve).not.toHaveBeenCalled();
    expect(await discoveryStatus(nats.store, 'test', serverId)).toMatchObject({ state: 'checking' });
  } finally {
    await workerApp.close();
  }
  const db = pgDb(dbs.queue);
  const logger = createLogger('admission-test', { level: 'silent' });
  const runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(mcpCatalogue);
  await runner.run(mcpCatalogue);
  const before = await db.query('SELECT * FROM mcp_catalogue');
  expect(before.rows[0]?.['policy']).toMatchObject({
    sequence: saved[1]!.sequence, policyRevision: saved[0]!.sequence });
  const env = { ...process.env, ...nats.env('projection'),
    DATABASE_URL: String(dbs.queue.options.connectionString) };
  const exec = promisify(execFile);
  const replay = await exec('npm', ['run', 'replay', '--', 'mcp-catalogue', '--verify'], { env });
  expect(replay.stdout).toContain('rebuilt state matched the live projection');
  expect((await db.query('SELECT * FROM mcp_catalogue')).rows).toEqual(before.rows);
  expect(await registrations()).toHaveLength(2);
}
it('recovers one result, expires it and replays without discovery or policy changes',
  savesResultAndReplays);

const invalid = [
  { attemptId: 2 }, { imageDigest: 'b'.repeat(64) }, { platform: 'linux/arm64' },
  { serverId: 'unknown' },
  { checks: { signature: { ...dated, checkedAt: new Date(now.getTime() + 1).toISOString() } } },
  { checks: { signature: { ...dated,
    expiresAt: new Date(now.getTime() + 86_400_001).toISOString() } } },
  { checks: { malware: { ...scanned,
    databaseUpdatedAt: new Date(now.getTime() - 86_400_001).toISOString() } } },
  { checks: { signature: { verdict: 'not_run' } } },
  { checks: { signature: { ...dated, verdict: 'fail' } } },
  { checks: { signature: { ...dated, reportDigest: undefined } } },
];
async function refusesResult(patch: Record<string, unknown>) {
  const serverId = await installed();
  const valid = result(serverId);
  const checks = { ...valid.checks, ...(patch['checks'] as object ?? {}) };
  const payload = { ...valid, ...patch, checks };
  expect((await writeHostedAdmission(nats.store, 'test', payload, now)).status).toBe('conflict');
  const rows = await history(nats.store, `mcp-${serverId}`, 'test');
  expect(rows).toHaveLength(1);
  const event = { ...rows[0]!.event, type: 'mcp.image_checked', data: payload,
    source: 'models', principal: { kind: 'system' as const, id: 'models' },
    time: now.toISOString() };
  expect(foldHostedAdmission([...rows, { event, sequence: 99 }], 'test', serverId, now))
    .toMatchObject({ status: 'checking' });
}
it.each(invalid)('refuses invalid writer and stored results %j', refusesResult);

async function checksVerdictsAndPrincipals() {
  const serverId = await installed();
  const valid = result(serverId);
  const rows = await registrations();
  const failed = { ...dated, verdict: 'fail', reasonCodes: ['unsigned'] };
  const checks = { signature: failed, licence: { verdict: 'not_run' },
    vulnerability: { verdict: 'not_run' }, malware: { verdict: 'not_run' } };
  const payload = { ...valid, checks };
  expect(getEventDefinition('mcp.image_checked')!.dataSchema.safeParse(payload).success).toBe(true);
  const event = envelope('test', `mcp-${serverId}`, 'mcp.image_checked', payload, 'result', now);
  expect(foldHostedAdmission([...rows, { event, sequence: 99 }], 'test', serverId, now))
    .toMatchObject({ status: 'rejected', checks: { signature: { reasonCodes: ['unsigned'] } } });
  const changes = [{ source: 'server' }, { principal: { kind: 'human' as const, id: 'models' } },
    { principal: { kind: 'system' as const, id: 'other' } }, { silo: 'other' },
    { subject: 'mcp-other' }];
  for (const change of changes) {
    const forged = { event: { ...event, ...change }, sequence: 99 };
    expect(foldHostedAdmission([...rows, forged], 'test', serverId, now))
      .toMatchObject({ status: 'checking' });
  }
  const unavailable = { ...dated, verdict: 'unavailable' };
  const unavailableResult = { ...valid, checks: { ...valid.checks, signature: unavailable } };
  expect((await writeHostedAdmission(nats.store, 'test', unavailableResult, now)).status)
    .toBe('appended');
  expect((await status(serverId)).json()).toMatchObject({ status: 'unavailable' });
}
it('reports failed and unavailable checks and ignores forged stored results',
  checksVerdictsAndPrincipals);

async function protectsReads() {
  const serverId = await installed();
  expect((await status('unknown')).statusCode).toBe(404);
  expect((await status(serverId, 'bob')).statusCode).toBe(403);
  const applied = auth.applied.bind(auth);
  async function delayedApplied(eventId: string) {
    await delay(2_100);
    return applied(eventId);
  }
  vi.spyOn(auth, 'applied').mockImplementationOnce(delayedApplied);
  expect((await status(serverId)).statusCode).toBe(200);
  const post = { method: 'POST' as const,
    url: `/api/org/integrations/${serverId}/admission`, headers: headers() };
  expect((await app.inject(post)).statusCode).toBe(404);
  const demotion = envelope('test', 'member-alice', 'member.role_changed',
    { memberId: 'alice', previousRole: 'admin', newRole: 'member', changedBy: 'amina' });
  const expectedSequence = await nats.store.head('member-alice');
  await nats.store.append({ event: demotion, expectedSequence });
  expect((await status(serverId)).statusCode).toBe(403);
}
it('checks current admin access once even when the IAM receipt takes over two seconds', protectsReads);
