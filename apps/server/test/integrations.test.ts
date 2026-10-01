import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { freePort, natsFixture } from '@opencrane/event-store/testing';
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
  const eventData = { ...definition.example, ...data } as Record<string, unknown>;
  if (type === 'mcp.server_registered' && !Object.hasOwn(data, 'catalogueRef')) delete eventData['catalogueRef'];
  if (type === 'mcp.server_discovered' && !Object.hasOwn(data, 'serverInfo')) delete eventData['serverInfo'];
  const parsed = parseEventByType({ id: `integration-${++id}`, commandId: `integration-${id}`, type,
    source: 'test', time: `2026-10-01T00:${String(id).padStart(2, '0')}:00Z`, subject, silo,
    principal: { id: 'admin', kind: 'human' }, data: eventData });
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
  runner = new ProjectionRunner(pgDb(dbs.queue), nats.reader, createLogger('integration-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(mcpCatalogue);
  authorisation = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  await member('alice', 'owner');
  await member('amina', 'admin');
  await member('bob', 'member');
  await runner.run(members);

  await mcp('odoo', 'mcp.server_registered', { kind: 'remote', locator: 'https://odoo.example.test/mcp',
    catalogueRef: 'catalogue:odoo' });
  await mcp('odoo', 'mcp.server_discovered', { toolCount: 14, schemaDigest: 'a'.repeat(64),
    serverInfo: { name: 'Odoo Accounting', version: '1.4.2' } });
  await mcp('odoo', 'mcp.tool_mode_set', { toolName: 'read', mode: 'allow', setBy: 'alice' });
  await mcp('odoo', 'mcp.tool_mode_set', { toolName: 'write', mode: 'ask', setBy: 'alice' });
  await mcp('odoo', 'mcp.tool_mode_set', { toolName: 'delete', mode: 'block', setBy: 'alice' });
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
  const response = await app.inject({ method: 'GET', url: '/api/org/integrations', headers: headers('oidc-alice') });
  expect(response.statusCode).toBe(200);
  const body = integrationsResponseSchema.parse(response.json());
  expect(body.loadedAt).toBe('2026-10-01T09:40:00.000Z');
  expect(body.rows.map((row) => [row.serverId, row.status.kind])).toEqual([
    ['odoo', 'ready'], ['warehouse', 'checking'], ['broken', 'failed'], ['pricing', 'needs_input'], ['review', 'needs_input'],
    ['retired', 'disabled'],
  ]);
  expect(body.rows[0]).toMatchObject({ name: 'Odoo Accounting', version: '1.4.2', toolsAllowed: 2, toolsTotal: 14,
    source: { kind: 'catalogue', label: 'Catalogue', detail: 'catalogue:odoo' }, accountModel: 'Not provided' });
  expect(body.rows.find((row) => row.serverId === 'pricing')).toMatchObject({
    name: 'Pricing', version: 'Version not provided', source: { kind: 'remote_url' }, accountModel: 'Not provided',
  });
  expect(body.rows.find((row) => row.serverId === 'review')?.status.detail).toBe('Pending review');
  expect(body.rows.some((row) => row.serverId === 'foreign')).toBe(false);
  const incremental = await catalogue.rows('test');
  await runner.rebuild(mcpCatalogue);
  expect(await catalogue.rows('test')).toEqual(incremental);
});

it.each([['oidc-alice', 200], ['oidc-amina', 200], ['oidc-bob', 403]])(
  'checks the projected role for %s', async (sub, status) => {
    expect((await app.inject({ method: 'GET', url: '/api/org/integrations', headers: headers(sub) })).statusCode).toBe(status);
  },
);

it('refuses another organisation and a cookie role without projected membership', async () => {
  const other = await app.inject({ method: 'GET', url: '/api/org/integrations', headers: headers('oidc-alice', 'org-other') });
  expect(other.statusCode).toBe(403);
  expect(other.json()).toMatchObject({ reason: 'wrong_silo' });
  const unknown = await app.inject({ method: 'GET', url: '/api/org/integrations', headers: headers('oidc-mallory') });
  expect(unknown.statusCode).toBe(403);
  expect(unknown.json()).toEqual({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
});

it('loads through the dev proxy and preserves the accessible refresh journey in Chromium', async () => {
  const apiPort = await freePort();
  const webPort = await freePort();
  await app.listen({ host: '127.0.0.1', port: apiPort });
  const directory = await mkdtemp(join(tmpdir(), 'opencrane-org-browser-'));
  const proxy = join(directory, 'proxy.json');
  const target = `http://127.0.0.1:${apiPort}`;
  await writeFile(proxy, JSON.stringify({
    '/api': { target, changeOrigin: true, secure: false },
    '/auth': { target, changeOrigin: true, secure: false },
    '/ws': { target, changeOrigin: true, secure: false, ws: true },
  }));
  let output = '';
  const cli = resolve('node_modules/@angular/cli/bin/ng.js');
  const web = spawn(process.execPath, [cli, 'serve', '--host', '127.0.0.1', '--port', String(webPort), '--proxy-config', proxy],
    { cwd: resolve('apps/web'), stdio: ['ignore', 'pipe', 'pipe'] });
  web.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  web.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const webExited = once(web, 'exit');
  const base = `http://127.0.0.1:${webPort}`;
  const browser = await chromium.launch({ headless: true });
  try {
    await vi.waitFor(async () => {
      expect(web.exitCode, output).toBeNull();
      expect(await fetch(base).then((response) => response.ok, () => false), output).toBe(true);
    }, { timeout: 60_000, interval: 200 });
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.addCookies([{ name: config.cookieName, value: encodeSession(config,
      { sub: 'oidc-alice', orgId: 'org-acme', roles: [], authTime: 0, exp: 2_000_000_000 }), url: base }]);
    const page = await context.newPage();
    const apiResponse = page.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
    await page.goto(`${base}/org/integrations`);
    expect((await apiResponse).status()).toBe(200);
    await page.locator('.register-row').first().waitFor();
    expect(await page.locator('.register-row').count()).toBe(6);

    const allTab = page.getByRole('tab', { name: /^All/ });
    await allTab.focus();
    await allTab.press('End');
    expect(await page.locator(':focus').getAttribute('id')).toBe('integrations-tab-review');
    expect(await page.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('integrations-tab-review');
    await page.getByRole('tab', { name: /^Pending review/ }).press('Home');
    expect(await page.locator(':focus').getAttribute('id')).toBe('integrations-tab-all');
    await page.getByRole('tab', { name: /^All/ }).press('ArrowRight');
    expect(await page.locator(':focus').getAttribute('id')).toBe('integrations-tab-attention');
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByRole('tab', { name: /^All/ }).press('Tab');
    expect(await page.locator(':focus').getAttribute('id')).toBe('integrations-panel');

    await page.getByRole('button', { name: 'Add MCP server' }).click();
    await page.getByText("Adding MCP servers isn't available yet").waitFor();
    expect(await page.locator('.register-row button').count()).toBe(0);
    const interactive = page.locator('button:visible, a:visible');
    const targets = await Promise.all(Array.from({ length: await interactive.count() }, async (_, index) => {
      const target = interactive.nth(index);
      return { text: (await target.textContent())?.trim(), height: (await target.boundingBox())?.height ?? 0 };
    }));
    expect(targets.filter((target) => target.height < 44)).toEqual([]);

    const held = await dbs.queue.connect();
    try {
      await held.query('BEGIN');
      await held.query('LOCK TABLE mcp_catalogue IN ACCESS EXCLUSIVE MODE');
      const refresh = page.locator('.page-actions .secondary');
      await refresh.focus();
      await refresh.click();
      await page.getByRole('button', { name: 'Refreshing list…' }).waitFor();
      expect(await page.locator(':focus').getAttribute('id')).toBe('refresh-integrations');
      expect(await refresh.getAttribute('aria-disabled')).toBe('true');
      await page.getByText(/Showing what we loaded at 09:40/).waitFor({ timeout: 5_000 });
      expect(await page.locator('.register-row').count()).toBe(6);

      const firstRead = await context.newPage();
      const firstFailure = firstRead.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
      await firstRead.goto(`${base}/org/integrations`);
      expect((await firstFailure).status()).toBe(503);
      await firstRead.getByText("Couldn't load the integrations list.").waitFor();
      const retryFailure = firstRead.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
      await firstRead.getByRole('button', { name: 'Refresh list' }).click();
      await firstRead.getByText('Refreshing the integrations list…').waitFor();
      expect(await firstRead.getByText('Nothing set up yet').count()).toBe(0);
      expect((await retryFailure).status()).toBe(503);
      expect(await firstRead.getByText('Nothing set up yet').count()).toBe(0);
      await firstRead.close();
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }

    const roleChanged = fixture('member.role_changed', 'member-alice', {
      memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'amina',
    });
    await append(roleChanged);
    await runner.run(members);
    await authorisation.handler.handle(roleChanged, pgDb(dbs.queue));
    const refused = page.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
    await page.getByRole('button', { name: 'Refresh list' }).click();
    expect((await refused).status()).toBe(403);
    await page.getByText('You no longer have permission').waitFor();
    expect(await page.getByText('Ask an Owner or Admin').count()).toBe(1);
    expect(await page.locator('.access-state button').count()).toBe(0);
    expect(await page.locator('.register-row').count()).toBe(0);

    await fga.pause();
    try {
      const unavailable = page.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
      await page.getByRole('button', { name: 'Refresh list' }).click();
      expect((await unavailable).status()).toBe(503);
      await page.getByText("Couldn't load the integrations list.").waitFor();
      expect(await page.locator('.register-row').count()).toBe(0);
      expect(await page.getByText(/Showing what we loaded/).count()).toBe(0);
    } finally {
      await fga.resume();
    }
    await context.close();
  } finally {
    await browser.close();
    web.kill('SIGTERM');
    await Promise.race([webExited, new Promise((done) => setTimeout(done, 5_000))]);
    if (web.exitCode === null) web.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
