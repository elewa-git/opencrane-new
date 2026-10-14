import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { envelope, history } from '@opencrane/models';
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
let app: ReturnType<typeof Fastify>;

async function startFga() { fga = await openfga(); }
async function closeFga() { await fga.close(); }
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
  async function memberId(_silo: string, _issuer: string, sub: string) { return sub; }
  async function rows() { return []; }
  async function tools() { return emptyToolPolicy(); }
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
async function register(payload: unknown = command, sub = 'alice', origin?: string) {
  return app.inject({ method: 'POST', url: '/api/org/integrations',
    headers: headers(sub, origin), payload });
}
async function status(commandId: string) {
  return app.inject({ method: 'GET', url: `/api/org/integrations/changes/${commandId}`,
    headers: headers() });
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
  const recovered = await status(command.commandId);
  expect(recovered.statusCode).toBe(200);
  expect(recovered.json()).toMatchObject({ ...receipt, status: 'applied',
    operation: 'register', sequence: saved[0]?.sequence });
  expect((await status('never-seen')).json()).toMatchObject({ status: 'unknown' });
  expect(await registrations()).toHaveLength(1);
}
it('saves attempt one and recovers the original operation after a lost reply', savesAndRecovers);

const invalid = [
  { locator: 'ghcr.io/elewa/test:latest' },
  { locator: command.locator.replace('@', ':latest@') },
  { locator: command.locator.replace('sha256', 'sha512') },
  { locator: command.locator.slice(0, -1) },
  { platform: 'linux/riscv64' },
  { upstream: { host: 'metadata.internal', port: 443 } },
  { upstream: { host: '127.0.0.1', port: 443 } },
  { extra: true },
];
async function rejectsInvalidInput(patch: object) {
  expect((await register({ ...command, ...patch })).statusCode).toBe(400);
  expect(await registrations()).toHaveLength(0);
}
it.each(invalid)('refuses invalid input %j without appending', rejectsInvalidInput);

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
    expect(schema.safeParse({ ...saved.data as object,
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
