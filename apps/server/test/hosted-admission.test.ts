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
import { envelope, readHostedAdmission, foldHostedAdmission } from '@opencrane/models';
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
  const queued = (await status(serverId)).json<{ status: string; queuedAt: string }>();
  expect(queued.status).toBe('checking');
  expect(Number.isFinite(Date.parse(queued.queuedAt))).toBe(true);
  const payload = result(serverId);
  payload.checks.signature = { ...dated,
    expiresAt: new Date(now.getTime() + 1_800_000).toISOString() };
  await appendCheckedFixture(payload);
  const saved = await registrations();
  expect(saved).toHaveLength(2);
  expect(saved[1]?.event).toMatchObject({ type: 'mcp.image_checked', source: 'models',
    principal: { kind: 'system', id: 'models' }, data: payload });
  expect((await status(serverId)).json()).toMatchObject({ status: 'admitted' });
  const expired = new Date(now.getTime() + 1_800_000);
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
it('reads a models result, expires it and replays without discovery or policy changes',
  savesResultAndReplays);

async function checksVerdictsAndPrincipals(verdict: 'fail' | 'unavailable') {
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
  const receipt = verdict === 'fail' ? failed : { ...dated, verdict: 'unavailable' };
  const savedResult = { ...valid, checks: { ...valid.checks, signature: receipt } };
  await appendCheckedFixture(savedResult);
  const expected = verdict === 'fail' ? 'rejected' : 'unavailable';
  expect((await status(serverId)).json()).toMatchObject({ status: expected,
    checks: { signature: receipt } });
}
it.each(['fail', 'unavailable'] as const)(
  'reports %s checks and ignores forged stored results', checksVerdictsAndPrincipals);

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

async function refusesForeignAndRemoteServers() {
  const serverId = await installed();
  expect(await readHostedAdmission(nats.store, 'other', serverId, now)).toBeUndefined();
  const foreign = envelope('other', 'mcp-foreign', 'mcp.server_registered',
    { serverId: 'foreign', registeredBy: 'alice', kind: 'hosted', locator: command.locator,
      installation: { attemptId: 1, platform: command.platform, upstream: command.upstream } });
  foreign.principal = { kind: 'human', id: 'alice' };
  await nats.store.append({ event: foreign, expectedSequence: 0 });
  expect((await status('foreign')).statusCode).toBe(404);
  const remote = envelope('test', 'mcp-remote', 'mcp.server_registered',
    { serverId: 'remote', registeredBy: 'alice', kind: 'remote', locator: 'https://example.com' });
  remote.principal = { kind: 'human', id: 'alice' };
  await nats.store.append({ event: remote, expectedSequence: 0 });
  expect(await registrations()).toHaveLength(3);
  const session = { sub: 'alice', orgId: 'another-org', roles: ['owner'],
    authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  const response = await app.inject({ method: 'GET',
    url: `/api/org/integrations/${serverId}/admission`, headers: { cookie } });
  expect(response.statusCode).toBe(403);
}
it('refuses foreign and remote servers and a session from another organisation',
  refusesForeignAndRemoteServers);

const refusedPrincipals = [
  { kind: 'human', id: 'alice' },
  { kind: 'human', id: 'models' },
  { kind: 'system', id: 'server' },
] as const;

async function refusesOtherResultWriters(principal: typeof refusedPrincipals[number]) {
  const serverId = await installed();
  const before = await registrations();
  const event = envelope('test', `mcp-${serverId}`, 'mcp.image_checked',
    result(serverId), 'refused-result', now);
  event.principal = principal;
  const expectedSequence = before[0]!.sequence;
  const outcome = await nats.store.append({ event, expectedSequence });
  expect.soft(outcome).toEqual({ status: 'rejected', reason: 'invalid_event' });
  expect.soft(await registrations()).toEqual(before);
  const response = await status(serverId);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'checking' });
}
it.each(refusedPrincipals)(
  'refuses result principal %j without changing saved events or admission',
  refusesOtherResultWriters);

async function appendCheckedFixture(payload: { serverId: string }) {
  const subject = `mcp-${payload.serverId}`;
  const event = envelope('test', subject, 'mcp.image_checked', payload, 'result', now);
  const expectedSequence = await nats.store.head(subject);
  const outcome = await nats.store.append({ event, expectedSequence });
  expect(outcome.status).toBe('appended');
}

async function checkInput(serverId: string) {
  const saved = await registrations();
  return { commandId: 'recheck-image', expectedSequence: await nats.store.head(`mcp-${serverId}`),
    registrationRevision: saved[0]!.sequence, attemptId: 2,
    imageDigest: digest, platform: command.platform };
}
async function requestCheck(serverId: string, payload: Record<string, unknown>, sub = 'alice',
  origin?: string) {
  return app.inject({ method: 'POST', url: `/api/org/integrations/${serverId}/checks`,
    headers: headers(sub, origin), payload });
}
async function failedInstallation() {
  const serverId = await installed();
  const failed = { ...dated, verdict: 'fail', reasonCodes: ['unsigned'] };
  const payload = { ...result(serverId), checks: { signature: failed,
    licence: { verdict: 'not_run' }, vulnerability: { verdict: 'not_run' },
    malware: { verdict: 'not_run' } } };
  await appendCheckedFixture(payload);
  return serverId;
}
async function recoversRequestedCheck() {
  const serverId = await failedInstallation();
  const input = await checkInput(serverId);
  const append = nats.store.append.bind(nats.store);
  async function lostReply(entry: Parameters<typeof append>[0]): ReturnType<typeof append> {
    await append(entry);
    throw new Error('Lost acknowledgement');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(lostReply);
  expect((await requestCheck(serverId, input)).statusCode).toBe(503);
  const response = await requestCheck(serverId, input);
  expect(response.statusCode).toBe(202);
  const receipt = response.json();
  expect(receipt).toMatchObject({ status: 'appended', serverId, attemptId: 2,
    changeRef: 'chg_recheck-image' });
  expect((await requestCheck(serverId, input)).json()).toEqual(receipt);
  const saved = await registrations();
  expect(saved).toHaveLength(3);
  expect(saved[2]?.event).toMatchObject({ type: 'mcp.image_check_requested',
    commandId: input.commandId, principal: { kind: 'human', id: 'alice' },
    data: { serverId, attemptId: 2, registrationRevision: input.registrationRevision,
      expectedSequence: input.expectedSequence, imageDigest: digest, platform: command.platform } });
  expect((await status(serverId)).json()).toMatchObject({ status: 'checking', attemptId: 2 });
  const next = { ...input, commandId: 'another', attemptId: 3,
    expectedSequence: saved[2]!.sequence };
  expect((await requestCheck(serverId, next)).statusCode).toBe(409);
  for (const patch of [{ imageDigest: 'b'.repeat(64) }, { platform: 'linux/arm64' },
    { expectedSequence: 0 }, { registrationRevision: 99 }, { attemptId: 3 }]) {
    expect((await requestCheck(serverId, { ...input, ...patch })).statusCode).toBe(409);
  }
  expect((await requestCheck(serverId, input, 'amina')).statusCode).toBe(409);
  await verifyRequestedReplay(serverId, saved[2]!.sequence, input.registrationRevision);
  expect(await registrations()).toEqual(saved);
}
it('recovers one requested check after a lost append reply and rejects changed retries',
  recoversRequestedCheck);

async function verifyRequestedReplay(serverId: string, sequence: number, revision: number) {
  const before = await readHostedAdmission(nats.store, 'test', serverId);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, nats.reader,
    createLogger('check-request-test', { level: 'silent' }));
  await runner.initialise(mcpCatalogue);
  await runner.run(mcpCatalogue);
  const rows = await db.query('SELECT * FROM mcp_catalogue');
  expect(rows.rows[0]?.['policy']).toMatchObject({ sequence, policyRevision: revision });
  const env = { ...process.env, ...nats.env('projection'),
    DATABASE_URL: String(dbs.queue.options.connectionString) };
  const exec = promisify(execFile);
  const replay = await exec('npm', ['run', 'replay', '--', 'mcp-catalogue', '--verify'], { env });
  expect(replay.stdout).toContain('rebuilt state matched the live projection');
  expect((await db.query('SELECT * FROM mcp_catalogue')).rows).toEqual(rows.rows);
  expect(await readHostedAdmission(nats.store, 'test', serverId)).toEqual(before);
  const workerApp = Fastify();
  const resolve = vi.fn();
  try {
    await installWorker(workerApp, nats.store, 'test', { resolve }).discover(serverId);
    expect(resolve).not.toHaveBeenCalled();
    expect(await discoveryStatus(nats.store, 'test', serverId)).toMatchObject({ state: 'checking' });
  } finally {
    await workerApp.close();
  }
}

async function refusesUnfinishedCheck(state: 'pending' | 'admitted' | 'unavailable' | 'mixed') {
  const serverId = await installed();
  if (state !== 'pending') {
    const valid = result(serverId);
    let signature: Record<string, unknown> = dated;
    if (state === 'unavailable' || state === 'mixed') {
      signature = { ...dated, verdict: 'unavailable' };
    }
    let licence: Record<string, unknown> = dated;
    if (state === 'mixed') licence = { ...dated, verdict: 'fail', reasonCodes: ['licence'] };
    await appendCheckedFixture({ ...valid, checks: { ...valid.checks, signature, licence } });
  }
  const before = await registrations();
  const response = await requestCheck(serverId, await checkInput(serverId));
  expect(response.statusCode).toBe(409);
  expect(await registrations()).toEqual(before);
  if (state === 'unavailable' || state === 'mixed') {
    expect((await status(serverId)).json()).toMatchObject({ status: 'unavailable' });
  }
}
it.each(['pending', 'admitted', 'unavailable', 'mixed'] as const)(
  'does not bypass a %s attempt', refusesUnfinishedCheck);

async function advancesExpiredCheck() {
  const serverId = await installed();
  const old = new Date(Date.now() - 10_000);
  const receipt = { ...dated, checkedAt: old.toISOString(),
    expiresAt: new Date(old.getTime() + 1_000).toISOString() };
  const scannedReceipt = { ...receipt, databaseDigest: digest, databaseUpdatedAt: old.toISOString() };
  const payload = { ...result(serverId), checks: { signature: receipt, licence: receipt,
    malware: scannedReceipt, vulnerability: scannedReceipt } };
  await appendCheckedFixture(payload);
  expect((await status(serverId)).json()).toMatchObject({ status: 'expired' });
  expect((await requestCheck(serverId, await checkInput(serverId))).statusCode).toBe(202);
  expect((await status(serverId)).json()).toMatchObject({ status: 'checking', attemptId: 2 });
}
it('queues the next attempt after dated evidence expires', advancesExpiredCheck);

async function rejectsInvalidRequest() {
  const serverId = await failedInstallation();
  const input = await checkInput(serverId);
  for (const patch of [{ imageDigest: 'latest' }, { locator: 'repo:latest' },
    { imageDigest: 'b'.repeat(64) }, { platform: 'linux/arm64' },
    { expectedSequence: 0 }, { registrationRevision: 99 }, { attemptId: 4 }]) {
    const response = await requestCheck(serverId, { ...input, ...patch });
    expect([400, 409]).toContain(response.statusCode);
  }
  expect((await requestCheck(serverId, input, 'bob')).statusCode).toBe(403);
  expect((await requestCheck(serverId, input, 'alice', 'https://other.test')).statusCode).toBe(403);
  expect((await requestCheck('unknown', input)).statusCode).toBe(404);
  for (const [id, silo, kind] of [['foreign', 'other', 'hosted'], ['remote', 'test', 'remote']]) {
    const data = { serverId: id, registeredBy: 'alice', kind,
      locator: kind === 'hosted' ? command.locator : 'https://example.com' };
    const event = envelope(silo!, `mcp-${id}`, 'mcp.server_registered', data);
    event.principal = { kind: 'human', id: 'alice' };
    await nats.store.append({ event, expectedSequence: 0 });
    expect((await requestCheck(id!, input)).statusCode).toBe(404);
  }
  vi.spyOn(auth, 'applied').mockResolvedValue(false);
  expect((await requestCheck(serverId, input)).statusCode).toBe(503);
}
it('requires exact hosted identity, origin and applied admin rights', rejectsInvalidRequest);

async function serialisesRequests(sameCommand: boolean) {
  const serverId = await failedInstallation();
  const input = await checkInput(serverId);
  const second = { ...input, commandId: sameCommand ? input.commandId : 'competing' };
  const requests = [requestCheck(serverId, input), requestCheck(serverId, second)];
  const responses = await Promise.all(requests);
  const codes = [];
  for (const response of responses) codes.push(response.statusCode);
  codes.sort();
  if (sameCommand) expect(codes).toEqual([202, 202]);
  else expect(codes).toEqual([202, 409]);
  expect(await registrations()).toHaveLength(3);
}
it.each([true, false])('serialises concurrent requests (same command: %s)', serialisesRequests);

async function refusesPreparationChange(change: 'registration' | 'role') {
  const serverId = await failedInstallation();
  const input = await checkInput(serverId);
  const read = nats.store.readStream.bind(nats.store);
  async function* changedHistory(...args: Parameters<typeof read>): ReturnType<typeof read> {
    yield* read(...args);
    if (args[0] !== `mcp-${serverId}`) return;
    if (change === 'role') {
      const event = envelope('test', 'member-alice', 'member.role_changed',
        { memberId: 'alice', previousRole: 'admin', newRole: 'member', changedBy: 'amina' });
      await nats.store.append({ event, expectedSequence: await nats.store.head('member-alice') });
    } else {
      const data = { serverId, kind: 'hosted', registeredBy: 'alice', locator: command.locator,
        installation: { attemptId: 1, platform: command.platform, upstream: command.upstream } };
      const event = envelope('test', `mcp-${serverId}`, 'mcp.server_registered', data);
      event.principal = { kind: 'human', id: 'alice' };
      await nats.store.append({ event, expectedSequence: input.expectedSequence });
    }
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(changedHistory);
  const response = await requestCheck(serverId, input);
  expect(response.statusCode).toBe(change === 'role' ? 403 : 409);
  vi.restoreAllMocks();
  const rows = await registrations();
  for (const row of rows) expect(row.event.type).not.toBe('mcp.image_check_requested');
}
it.each(['registration', 'role'] as const)(
  'refuses a %s change during preparation', refusesPreparationChange);
