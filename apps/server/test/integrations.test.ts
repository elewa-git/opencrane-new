import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { connectMcpCatalogue, connectMemberFeed, mcpCatalogue, members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { integrationsResponseSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org-acme' };
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let catalogue: ReturnType<typeof connectMcpCatalogue>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let authorisation: ReturnType<typeof memberAuthorisation>;
let id = 0;
const streamSequences = new Map<string, number>();

beforeAll(async () => { fga = await openfga(); }, 120_000);
afterAll(async () => { await fga.close(); });

function fixture(type: string, subject: string, data: Record<string, unknown>, silo = 'test'): EventEnvelope {
  const definition = getEventDefinition(type);
  if (!definition || typeof definition.example !== 'object' || definition.example === null) throw new Error('Bad fixture type');
  const parsed = parseEventByType({ id: `integration-${++id}`, commandId: `integration-${id}`, type,
    source: 'test', time: `2026-10-01T${String(id).padStart(2, '0')}:00:00Z`, subject, silo,
    principal: { id: 'admin', kind: 'human' }, data: { ...definition.example, ...data } });
  if (!parsed.success) throw new Error(`Bad ${type} fixture: ${parsed.reason}`);
  return parsed.event;
}

async function append(event: EventEnvelope) {
  const expectedSequence = streamSequences.get(event.subject) ?? 0;
  const result = await nats.store.append({ event, expectedSequence });
  expect(result.status).toBe('appended');
  if (result.status === 'appended') streamSequences.set(event.subject, result.sequence);
}

async function member(memberId: string, role: 'owner' | 'admin' | 'member') {
  const subject = `member-${memberId}`;
  await append(fixture('member.invited', subject, { memberId, role, invitationId: `invite-${memberId}`,
    invitedIdentity: { issuer: config.issuerUrl, sub: `oidc-${memberId}` }, expiresAt: '2026-10-02T00:00:00Z' }));
  const joined = { ...fixture('member.joined', subject, { memberId, role, email: `${memberId}@example.test`,
    displayName: memberId, invitationId: `invite-${memberId}` }), principal: { id: `oidc-${memberId}`, kind: 'human' as const } };
  await append(joined);
  await authorisation.handler.handle(joined, pgDb(dbs.queue));
}

async function mcp(serverId: string, type: string, data: Record<string, unknown>, silo = 'test') {
  await append(fixture(type, `mcp-${serverId}`, { serverId, ...data }, silo));
}

function headers(sub: string, orgId = 'org-acme') {
  const now = Math.floor(Date.now() / 1000);
  return { cookie: `${config.cookieName}=${encodeSession(config,
    { sub, orgId, roles: ['owner'], authTime: now, exp: now + 60 })}` };
}

beforeEach(async () => {
  dbs = await databases();
  nats = await natsFixture();
  id = 0;
  streamSequences.clear();
  runner = new ProjectionRunner(pgDb(dbs.queue), nats.store, createLogger('integration-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(mcpCatalogue);
  authorisation = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  await member('alice', 'owner');
  await member('amina', 'admin');
  await member('bob', 'member');
  await runner.run(members);

  await mcp('odoo', 'mcp.server_registered', { kind: 'remote', locator: 'https://odoo.example.test/mcp' });
  await mcp('odoo', 'mcp.server_discovered', { toolCount: 14, schemaDigest: 'a'.repeat(64) });
  await mcp('odoo', 'mcp.tool_mode_set', { toolName: 'read', mode: 'allow', setBy: 'alice' });
  await mcp('odoo', 'mcp.tool_mode_set', { toolName: 'write', mode: 'ask', setBy: 'alice' });
  await mcp('odoo', 'mcp.server_published', { publishedBy: 'alice' });
  await mcp('warehouse', 'mcp.server_registered', { kind: 'hosted',
    locator: `ghcr.io/kijani/warehouse@sha256:${'b'.repeat(64)}` });
  await mcp('broken', 'mcp.server_registered', { kind: 'remote', locator: 'https://broken.example.test/mcp' });
  await mcp('broken', 'mcp.server_rejected', { reason: 'ssrf_guard_failed' });
  await mcp('pricing', 'mcp.server_registered', { kind: 'remote', locator: 'https://pricing.example.test/mcp' });
  await mcp('pricing', 'mcp.server_discovered', { toolCount: 3, schemaDigest: 'c'.repeat(64) });
  await mcp('pricing', 'mcp.tools_changed', { previousSchemaDigest: 'c'.repeat(64), newSchemaDigest: 'd'.repeat(64) });
  await mcp('review', 'mcp.server_registered', { kind: 'remote', locator: 'https://review.example.test/mcp' });
  await mcp('review', 'mcp.server_discovered', { toolCount: 4, schemaDigest: 'e'.repeat(64) });
  await mcp('retired', 'mcp.server_registered', { kind: 'remote', locator: 'https://retired.example.test/mcp' });
  await mcp('retired', 'mcp.server_published', { publishedBy: 'alice' });
  await mcp('retired', 'mcp.server_unpublished', { unpublishedBy: 'alice' });
  await mcp('foreign', 'mcp.server_registered', { kind: 'remote', locator: 'https://foreign.example.test/mcp' }, 'other');
  await runner.run(mcpCatalogue);

  const connectionString = String(dbs.queue.options.connectionString);
  feed = await connectMemberFeed(connectionString);
  catalogue = connectMcpCatalogue(connectionString);
  app = buildServer(config, { integrations: { silo: 'test', feed, catalogue, binding: authorisation.binding,
    now: () => new Date('2026-10-01T09:40:00Z') } });
});

afterEach(async () => {
  await app?.close();
  await feed?.close();
  await catalogue?.close();
  await nats?.close();
  await dbs?.close();
});

it('returns the event-derived register and rebuilds to the same rows', async () => {
  const response = await app.inject({ method: 'GET', url: '/org/integrations', headers: headers('oidc-alice') });
  expect(response.statusCode).toBe(200);
  const body = integrationsResponseSchema.parse(response.json());
  expect(body.loadedAt).toBe('2026-10-01T09:40:00.000Z');
  expect(body.rows.map((row) => [row.serverId, row.status.kind])).toEqual([
    ['odoo', 'ready'], ['warehouse', 'checking'], ['broken', 'failed'], ['pricing', 'needs_input'], ['review', 'needs_input'],
    ['retired', 'disabled'],
  ]);
  expect(body.rows[0]).toMatchObject({ name: 'Odoo', toolsAllowed: 2, toolsTotal: 14,
    source: { kind: 'remote_url', detail: 'odoo.example.test' }, accountModel: 'Not configured' });
  expect(body.rows.find((row) => row.serverId === 'review')?.status.detail).toBe('Pending review');
  expect(body.rows.some((row) => row.serverId === 'foreign')).toBe(false);
  const incremental = await catalogue.rows('test');
  await runner.rebuild(mcpCatalogue);
  expect(await catalogue.rows('test')).toEqual(incremental);
});

it.each([['oidc-alice', 200], ['oidc-amina', 200], ['oidc-bob', 403]])(
  'checks the projected role for %s', async (sub, status) => {
    expect((await app.inject({ method: 'GET', url: '/org/integrations', headers: headers(sub) })).statusCode).toBe(status);
  },
);

it('refuses another organisation and a cookie role without projected membership', async () => {
  const other = await app.inject({ method: 'GET', url: '/org/integrations', headers: headers('oidc-alice', 'org-other') });
  expect(other.statusCode).toBe(403);
  expect(other.json()).toMatchObject({ reason: 'wrong_silo' });
  const unknown = await app.inject({ method: 'GET', url: '/org/integrations', headers: headers('oidc-mallory') });
  expect(unknown.statusCode).toBe(403);
  expect(unknown.json()).toEqual({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
});
