import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type HTTPMethods, type RouteOptions } from 'fastify';
import { Client } from 'minio/dist/esm/minio.mjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sessionCookie, testAuthConfig } from '@opencrane/auth/testing';
import { databases, openfga, permissionStore } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { connectComputers, connectMcpCatalogue, connectMemberFeed, conversationKeys,
  members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { registerRoutes, type BuildServerOptions } from '../src/server.ts';

interface WriteRoute {
  method: HTTPMethods;
  url: string;
}
interface CredentialRoute {
  route: string;
  credential: string;
  test: string;
  reason: string;
}
interface Refusal {
  route: string;
  probe: string;
  status: number;
  reason: string;
}
interface MembershipGap {
  route: string;
  reason: string;
}

const otherCredential: CredentialRoute[] = [
  { route: 'POST /auth/logout', credential: 'Organisation session for sign-out',
    test: 'apps/server/test/auth-flow.test.ts',
    reason: 'Sign-in routes manage the session before silo membership is checked.' },
  { route: 'POST /api/silo/claim', credential: 'Organisation session and first-owner token',
    test: 'apps/server/test/bootstrap-claim.test.ts',
    reason: 'The first owner has no existing silo membership.' },
  { route: 'POST /internal/mcp/instances/:instanceId/observations',
    credential: 'Short-lived worker bearer issued by trusted server code',
    test: 'apps/server/test/mcp-instance-worker.test.ts',
    reason: 'A worker reports observations without a member session.' },
  { route: 'POST /mcp/memory/server', credential: 'Signed x-memory-context token',
    test: 'apps/server/test/memory-mcp.test.ts',
    reason: 'The gateway supplies the authenticated computer and turn context.' },
  { route: 'POST /mcp/memory/server/prepare', credential: 'Signed x-memory-context token',
    test: 'apps/server/test/memory-mcp.test.ts',
    reason: 'The gateway supplies the authenticated computer and turn context.' },
];
const refusedWithOtherStatus: Refusal[] = [];
const membershipNotProbed: MembershipGap[] = [];
const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const routes: WriteRoute[] = [];
let app: FastifyInstance;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let catalogue: ReturnType<typeof connectMcpCatalogue>;
let computers: ReturnType<typeof connectComputers>;
let directory: string;

function recordRoute(route: RouteOptions) {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  for (const method of methods) {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      routes.push({ method, url: route.url });
    }
  }
}

function scan() {
  function validate() {
    return 'clean' as const;
  }
  return Promise.resolve(validate);
}

function refuseDesktopConnection(): never {
  throw new Error('An outsider must never open a desktop connection');
}

async function serverOptions(): Promise<BuildServerOptions> {
  const db = pgDb(dbs.queue);
  const permissions = await permissionStore(fga, 'acme');
  const logger = createLogger('write-routes-test', { level: 'silent' });
  const runner = new ProjectionRunner(db, nats.reader, logger);
  await runner.initialise(members);
  await runner.run(members);
  const connectionString = String(dbs.queue.options.connectionString);
  feed = await connectMemberFeed(connectionString);
  catalogue = connectMcpCatalogue(connectionString);
  computers = connectComputers(connectionString);
  directory = await mkdtemp(join(tmpdir(), 'write-routes-'));
  const shared = { silo: 'acme', store: nats.store, db, binding: permissions.binding, feed };
  const chat = { ...shared, keys: conversationKeys(directory) };
  const objects = new Client({ endPoint: '127.0.0.1' });
  const identity = { jwks: { keys: [] }, issuer: 'https://identity.example.test/' };
  return {
    membership: shared, groups: shared, memberReads: shared, invitationEmail: shared,
    ownership: shared, providers: shared, modelAccess: shared, audit: shared,
    chat, onboarding: chat, files: { ...shared, objects, scan },
    memory: { ...shared, chat, identity },
    integrations: { ...shared, catalogue, modelDb: db },
    mcpInstances: shared, computers: { ...shared, computers },
    liveView: { ...shared, open: refuseDesktopConnection },
  };
}

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const options = await serverOptions();
  app = Fastify();
  app.addHook('onRoute', recordRoute);
  registerRoutes(app, config, options);
  // Wait for encapsulated memory, takeover and file plugins to declare their routes.
  await app.ready();
}

async function close() {
  await app?.close();
  await feed?.close();
  await catalogue?.close();
  await computers?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
beforeAll(initialise, 120_000);
afterAll(close);

function routeName(route: WriteRoute) {
  return `${route.method} ${route.url}`;
}

function requestUrl(route: WriteRoute) {
  // A hexadecimal id also satisfies the stricter worker and memory path schemas.
  return route.url.replace(/:[A-Za-z][A-Za-z0-9_]*/gu, 'a'.repeat(64));
}

async function probe(route: WriteRoute, name: string, cookie?: { cookie: string }) {
  const headers = { origin: 'https://app.example.test', ...cookie };
  const before = await nats.store.head();
  const response = await app.inject({ method: route.method, url: requestUrl(route),
    headers, payload: {} });
  const context = `${routeName(route)} (${name})`;
  const succeeded = response.statusCode >= 200 && response.statusCode < 300;
  expect(succeeded, `SECURITY: ${context} returned ${response.statusCode}`).toBe(false);
  expect(await nats.store.head(), `SECURITY: ${context} changed the event log`).toBe(before);
  return response;
}

async function probeMemberRoute(route: WriteRoute) {
  const probes = [
    { name: 'no session', cookie: undefined },
    { name: 'wrong organisation', cookie: sessionCookie(config, { orgId: 'org-other' }) },
    { name: 'no active membership', cookie: sessionCookie(config) },
  ];
  for (const entry of probes) {
    const response = await probe(route, entry.name, entry.cookie);
    if (response.statusCode === 401 || response.statusCode === 403) continue;
    expect(response.statusCode, `${routeName(route)} (${entry.name})`).toBeLessThan(500);
    refusedWithOtherStatus.push({ route: routeName(route), probe: entry.name,
      status: response.statusCode, reason: 'The empty request body is refused before membership.' });
  }
}

async function refusesOutsiders() {
  const before = await nats.store.head();
  const probed = new Set<string>();
  const credentialRoutes = new Set<string>();
  for (const credential of otherCredential) credentialRoutes.add(credential.route);
  for (const route of routes) {
    const name = routeName(route);
    if (credentialRoutes.has(name)) {
      const response = await probe(route, 'no credential');
      expect([401, 403], name).toContain(response.statusCode);
    } else {
      await probeMemberRoute(route);
    }
    probed.add(name);
  }
  expect(await nats.store.head()).toBe(before);
  expect(routes.length).toBeGreaterThanOrEqual(35);
  for (const credential of otherCredential) expect(probed.has(credential.route)).toBe(true);
  const uncovered = routes.filter(isUncovered);
  expect(uncovered).toEqual([]);
  console.info(JSON.stringify({ recorded: routes.length, probed: probed.size,
    uncovered: uncovered.length, refusedWithOtherStatus, membershipNotProbed, otherCredential },
  null, 2));
  console.info(routes.map(routeName).join('\n'));

  function isUncovered(route: WriteRoute) {
    const name = routeName(route);
    return !probed.has(name) && !credentialRoutes.has(name);
  }
}
it('discovers every write route and refuses outsiders without saving events', refusesOutsiders);
