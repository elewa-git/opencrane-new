import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { envelope, history, hostedRegistrationChange } from '@opencrane/models';
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
  return app.inject({ method: 'GET', url: `/api/org/integrations/changes/${commandId}`,
    headers: headers(sub) });
}
async function registrations() {
  const rows = [];
  for await (const row of nats.store.readStream('mcp-*')) rows.push(row);
  return rows;
}

async function savesAndRecovers() {
  const response = await register();
  expect(response.statusCode).toBe(202);
  const receipt = response.json<{ serverId: string; changeRef: string }>();
  expect(receipt.changeRef).toBe(`chg_${command.commandId}`);
  const saved = await registrations();
  expect(saved).toHaveLength(1);
  expect(saved[0]?.event).toMatchObject({ type: 'mcp.server_registered',
    subject: `mcp-${receipt.serverId}`, silo: 'test', commandId: command.commandId,
    principal: { kind: 'human', id: 'alice' },
    data: { serverId: receipt.serverId, locator: command.locator, kind: 'hosted',
      installation: { attemptId: 1, platform: command.platform, upstream: command.upstream } } });
  const duplicate = await register();
  expect(duplicate.statusCode).toBe(202);
  expect(duplicate.json()).toEqual(receipt);
  expect(await registrations()).toHaveLength(1);
  const changed = await register({ ...command, platform: 'linux/arm64' });
  expect(changed.statusCode).toBe(409);
  expect((await register(command, 'amina')).statusCode).toBe(409);
  const rejection = envelope('test', `mcp-${receipt.serverId}`, 'mcp.server_rejected',
    { serverId: receipt.serverId, reason: 'scanner_unavailable' }, 'later-result');
  const append = { event: rejection, expectedSequence: saved[0]!.sequence };
  expect((await nats.store.append(append)).status).toBe('appended');
  const recovered = await status(command.commandId);
  expect(recovered.statusCode).toBe(200);
  expect(recovered.json()).toMatchObject({ ...receipt, status: 'applied',
    operation: 'register', sequence: saved[0]?.sequence });
  expect((await status('never-seen')).json()).toMatchObject({ status: 'unknown' });
  expect(await registrations()).toHaveLength(2);
}
it('saves attempt one and recovers the original operation after a lost reply', savesAndRecovers);

async function recoversLostAppendReply() {
  const append = nats.store.append.bind(nats.store);
  async function loseReply(input: Parameters<typeof append>[0]): ReturnType<typeof append> {
    await append(input);
    throw new Error('Reply lost after append');
  }
  vi.spyOn(nats.store, 'append').mockImplementationOnce(loseReply);
  expect((await register()).statusCode).toBe(503);
  const recovered = (await status(command.commandId)).json<{ serverId: string }>();
  const retried = await register();
  expect(retried.statusCode).toBe(202);
  expect(retried.json()).toMatchObject({ serverId: recovered.serverId });
  expect(await registrations()).toHaveLength(1);
}
it('recovers a saved append when its acknowledgement is lost', recoversLostAppendReply);

async function readsAppliedReceiptAfterTwoSeconds() {
  expect((await register()).statusCode).toBe(202);
  const applied = auth.applied.bind(auth);
  async function delayedApplied(eventId: string) {
    await delay(2_100);
    return applied(eventId);
  }
  const receiptRead = vi.spyOn(auth, 'applied').mockImplementation(delayedApplied);
  const response = await status(command.commandId);
  expect(receiptRead).toHaveBeenCalled();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'applied', operation: 'register' });
}
it('reads an applied registration after a slow access receipt', readsAppliedReceiptAfterTwoSeconds);

async function refusesUnauthorisedStatusReads() {
  expect((await register()).statusCode).toBe(202);
  expect((await status(command.commandId, 'bob')).statusCode).toBe(403);
  const wrongSiloSession = { sub: 'alice', orgId: 'another-org', roles: ['owner'],
    authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 };
  const cookie = `${config.cookieName}=${encodeSession(config, wrongSiloSession)}`;
  const wrongSilo = await app.inject({ method: 'GET',
    url: `/api/org/integrations/changes/${command.commandId}`, headers: { cookie } });
  expect(wrongSilo.statusCode).toBe(403);
  const demotion = envelope('test', 'member-alice', 'member.role_changed',
    { memberId: 'alice', previousRole: 'admin', newRole: 'member', changedBy: 'amina' },
    'demote-before-read');
  const expectedSequence = await nats.store.head('member-alice');
  expect((await nats.store.append({ event: demotion, expectedSequence })).status)
    .toBe('appended');
  expect((await status(command.commandId)).statusCode).toBe(403);
}
it('refuses member, wrong silo and demoted admin status reads', refusesUnauthorisedStatusReads);

async function refusesUnappliedRole() {
  const fields = { memberId: 'alice', previousRole: 'admin', newRole: 'admin',
    changedBy: 'amina' };
  const event = envelope('test', 'member-alice', 'member.role_changed', fields, 'unapplied');
  const expectedSequence = await nats.store.head('member-alice');
  expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
  expect((await register()).statusCode).toBe(503);
  expect(await registrations()).toHaveLength(0);
}
it('waits for the current admin facts to be applied to IAM', refusesUnappliedRole);

const invalid = [
  { locator: 'ghcr.io/elewa/test:latest' },
  { locator: command.locator.replace('@', ':latest@') },
  { locator: command.locator.replace('sha256', 'sha512') },
  { locator: command.locator.slice(0, -1) },
  { platform: 'linux/riscv64' },
  { upstream: { host: 'metadata.internal', port: 443 } },
  { upstream: { host: '127.0.0.1', port: 443 } },
  { extra: true },
  { commandId: 'bad.command' },
  { commandId: 'c'.repeat(201) },
  { locator: `ghcr.io/${'a'.repeat(1969)}@sha256:${'a'.repeat(64)}` },
];
async function rejectsInvalidInput(patch: object) {
  expect((await register({ ...command, ...patch })).statusCode).toBe(400);
  expect(await registrations()).toHaveLength(0);
}
it.each(invalid)('refuses invalid input %j without appending', rejectsInvalidInput);

async function refusesInvalidStatusCommandIds() {
  expect((await status('bad.command')).statusCode).toBe(400);
  await expect(hostedRegistrationChange(nats.store, 'test', 'c'.repeat(201)))
    .rejects.toThrow();
}
it('refuses invalid status command ids', refusesInvalidStatusCommandIds);

function refusesOtherInstallationAttempts() {
  const schema = getEventDefinition('mcp.server_registered')!.dataSchema;
  const installation = { attemptId: 2, platform: command.platform, upstream: command.upstream };
  const registration = { serverId: 'test-server', registeredBy: 'alice', kind: 'hosted',
    locator: command.locator, installation };
  expect(schema.safeParse(registration).success).toBe(false);
}
it('refuses a hosted installation attempt other than one', refusesOtherInstallationAttempts);

async function refusesAccess() {
  expect((await register(command, 'bob')).statusCode).toBe(403);
  expect((await register(command, 'alice', 'https://wrong.example')).statusCode).toBe(403);
  const event = envelope('test', 'member-alice', 'member.role_changed',
    { memberId: 'alice', previousRole: 'admin', newRole: 'member', changedBy: 'amina' },
    'demote');
  const expectedSequence = await nats.store.head('member-alice');
  expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
  expect((await register()).statusCode).toBe(403);
  expect(await registrations()).toHaveLength(0);
}
it('refuses members, wrong Origin and a demotion ahead of IAM', refusesAccess);

async function waitsWithoutDiscovery() {
  const response = await register();
  expect(response.statusCode).toBe(202);
  const { serverId } = response.json<{ serverId: string }>();
  const workerApp = Fastify();
  const resolve = vi.fn();
  const worker = installWorker(workerApp, nats.store, 'test', { resolve });
  try {
    await worker.discover(serverId);
    await worker.discover(serverId);
    expect(await discoveryStatus(nats.store, 'test', serverId)).toMatchObject({
      state: 'checking', changeRef: `chg_${command.commandId}` });
    expect(await history(nats.store, `mcp-${serverId}`, 'test')).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
    const saved = (await registrations())[0]!.event;
    expect(parseEventByType({ ...saved, subject: 'mcp-other' }).success).toBe(false);
    const schema = getEventDefinition('mcp.server_registered')!.dataSchema;
    const data = z.record(z.string(), z.unknown()).parse(saved.data);
    expect(schema.safeParse({ ...data,
      credentialContract: { credentialMode: 'startup_lasting' } }).success).toBe(false);
  } finally {
    await workerApp.close();
  }
}
it('keeps new credential-free hosted registrations checking without network or rejection',
  waitsWithoutDiscovery);

async function replaysRegistration() {
  expect((await register()).statusCode).toBe(202);
  const db = pgDb(dbs.queue);
  const logger = createLogger('hosted-registration-test', { level: 'silent' });
  const runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(mcpCatalogue);
  await runner.run(mcpCatalogue);
  const before = await db.query('SELECT * FROM mcp_catalogue');
  expect(before.rows).toHaveLength(1);
  expect(before.rows[0]).toMatchObject({ lifecycle: 'registered', source_kind: 'hosted' });
  const position = await nats.store.head();
  const env = { ...process.env, ...nats.env('projection'),
    DATABASE_URL: String(dbs.queue.options.connectionString) };
  const exec = promisify(execFile);
  const result = await exec('npm', ['run', 'replay', '--', 'mcp-catalogue', '--verify'], { env });
  expect(result.stdout).toContain('rebuilt state matched the live projection');
  expect((await db.query('SELECT * FROM mcp_catalogue')).rows).toEqual(before.rows);
  expect(await nats.store.head()).toBe(position);
}
it('replays registration through the catalogue and ops without appending', replaysRegistration);
