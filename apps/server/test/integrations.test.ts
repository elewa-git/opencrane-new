import { installWorker } from '../src/integrations/install-worker.ts';
import { remoteFixture } from './support/remote-mcp.ts';
import { budgets, BudgetActor, readBudget, startDecision, settlementHandler, history } from '@opencrane/models';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { chromium, type Page, type Response } from 'playwright';
import { encodeSession, tokenIssuer } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { auditTrail, computers, connectComputers, connectMcpCatalogue, connectMemberFeed, mcpCatalogue, members, pgDb, ProjectionRunner } from '@opencrane/projections';
import {
  computersResponseSchema, effectDetailResponseSchema, effectListResponseSchema,
  integrationsResponseSchema,
} from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org-acme' };
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let catalogue: ReturnType<typeof connectMcpCatalogue>;
let computerRows: ReturnType<typeof connectComputers>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let authorisation: ReturnType<typeof memberAuthorisation>;
let actor: BudgetActor;
let decision: Awaited<ReturnType<typeof startDecision>>;
let keyDirectory: string;
let tokens: Awaited<ReturnType<typeof tokenIssuer>>;
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
  await runner.initialise(auditTrail);
  await runner.initialise(budgets);
  actor = new BudgetActor(nats.store, 'test'); await actor.start(2000, 20000, 'personal-default');
  await runner.run(budgets);
  await runner.initialise(mcpCatalogue);
  await runner.initialise(computers);
  authorisation = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  await member('alice', 'owner');
  await member('amina', 'admin');
  await member('bob', 'member');
  await runner.run(members);

  await mcp('odoo', 'mcp.server_registered', { kind: 'remote', locator: 'https://odoo.example.test/mcp',
    catalogueRef: 'catalogue:odoo' });
  await mcp('odoo', 'mcp.server_discovered', { toolCount: 14, schemaDigest: 'a'.repeat(64),
    serverInfo: { name: 'Odoo Accounting', version: '1.4.2' }, connectionId: 'installed-odoo', accountMode: 'none',
    tools: [{ name: 'read', revision: 'a'.repeat(64), reviewed: true, readOnly: true, costCents: 0 },
      { name: 'write', revision: 'b'.repeat(64), reviewed: true, costCents: 0 }, { name: 'new', revision: 'c'.repeat(64), reviewed: false }] });
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
  const assistant = fixture('assistant.created', 'assistant-personal-alice', {
    assistantId: 'personal-alice', ownerId: 'alice', kind: 'personal',
  });
  await append(assistant);
  await authorisation.handler.handle(assistant, pgDb(dbs.queue));
  expect(await authorisation.actsFor('alice', 'personal-alice')).toMatchObject({ allowed: true });
  await append(fixture('computer.claimed', 'computer-personal-alice', { assistantId: 'personal-alice',
    computerId: 'computer-alice', sandboxUid: 'sandbox-alice', generation: 1, tokenId: 'token:alice' }));
  await append(fixture('computer.ready', 'computer-personal-alice', { assistantId: 'personal-alice', computerId: 'computer-alice' }));
  await runner.run(computers);

  const connectionString = String(dbs.queue.options.connectionString);
  feed = await connectMemberFeed(connectionString);
  catalogue = connectMcpCatalogue(connectionString);
  computerRows = connectComputers(connectionString);
  keyDirectory = await mkdtemp(`${tmpdir()}/budget-config-`);
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${keyDirectory}/key.pem`, key.privateKey, { mode: 0o600 });
  tokens = await tokenIssuer({ privateKeyPath: `${keyDirectory}/key.pem`, issuer: 'https://lifecycle.test/' });
  decision = await startDecision(actor, { jwks: tokens.jwks, issuer: 'https://lifecycle.test/' }, authorisation.binding);
  app = buildServer(config, { audit: { silo: 'test', store: nats.store, db: pgDb(dbs.queue), feed, binding: authorisation.binding }, integrations: { silo: 'test', store: nats.store, feed, catalogue, budget: { decisionUrl: decision.url, tokens }, modelDb: pgDb(dbs.queue), binding: authorisation.binding,
    now: () => new Date('2026-10-01T09:40:00Z') }, computers: { silo: 'test', feed,
    computers: computerRows, binding: authorisation.binding, now: () => new Date('2026-10-01T09:40:00Z') } });
}, 30_000);

afterEach(async () => {
  const results: PromiseSettledResult<void>[] = await Promise.allSettled([app?.close(), decision?.close()]);
  results.push(...await Promise.allSettled([feed?.close(), catalogue?.close(), computerRows?.close(), nats?.close()]));
  results.push(...await Promise.allSettled([dbs?.close()]));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown);
  if (keyDirectory) await rm(keyDirectory, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, 'Integration fixture cleanup failed');
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
  expect(body.rows[0]).toMatchObject({ name: 'Odoo Accounting', version: '1.4.2', toolsAllowed: 0, toolsTotal: 14,
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

it('returns computer status only to an owner or admin', async () => {
  for (const sub of ['oidc-alice', 'oidc-amina']) {
    const response = await app.inject({ method: 'GET', url: '/api/org/computers', headers: headers(sub) });
    expect(response.statusCode).toBe(200);
    expect(computersResponseSchema.parse(response.json()).rows).toEqual([{
      assistantId: 'personal-alice', ownerId: 'alice', kind: 'personal', computerId: 'computer-alice',
      generation: 1, status: 'ready', changedAt: '2026-10-01T00:27:00Z',
    }]);
  }
  expect((await app.inject({ method: 'GET', url: '/api/org/computers', headers: headers('oidc-bob') })).statusCode).toBe(403);
  expect((await app.inject({ method: 'GET', url: '/api/org/computers' })).statusCode).toBe(401);
});

it('refuses another organisation and a cookie role without projected membership', async () => {
  const other = await app.inject({ method: 'GET', url: '/api/org/integrations', headers: headers('oidc-alice', 'org-other') });
  expect(other.statusCode).toBe(403);
  expect(other.json()).toMatchObject({ reason: 'wrong_silo' });
  const unknown = await app.inject({ method: 'GET', url: '/api/org/integrations', headers: headers('oidc-mallory') });
  expect(unknown.statusCode).toBe(403);
  expect(unknown.json()).toEqual({ status: 'refused', reason: 'admin_required', requiredRole: 'Owner or Admin' });
});

it('loads through the dev proxy and preserves the accessible refresh journey in Chromium', async () => {
  const remote = await remoteFixture();
  installWorker(app, nats.store, 'test', remote.network).start();
  const target = await app.listen({ host: '127.0.0.1', port: 0 });
  const directory = await mkdtemp(join(tmpdir(), 'opencrane-org-browser-'));
  const proxy = join(directory, 'proxy.json');
  await writeFile(proxy, JSON.stringify({
    '/api': { target, changeOrigin: true, secure: false },
    '/auth': { target, changeOrigin: true, secure: false },
    '/ws': { target, changeOrigin: true, secure: false, ws: true },
  }));
  let output = '';
  const cli = resolve('node_modules/@angular/cli/bin/ng.js');
  const web = spawn(process.execPath, ['--experimental-strip-types', '--import',
    resolve('apps/server/test/support/ephemeral-ports.ts'), cli, 'serve', '--prebundle=false', '--host', '127.0.0.1', '--port', '0', '--proxy-config', proxy],
    // CI=true makes Angular colour its output; ask for plain text and strip any codes anyway.
    { cwd: resolve('apps/web'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  web.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  web.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const webExited = once(web, 'exit');
  let base = '';
  const originalRedirect = config.redirectUri;
  const browser = await chromium.launch({ headless: true });
  try {
    await vi.waitFor(async () => {
      expect(web.exitCode, output).toBeNull();
      // eslint-disable-next-line no-control-regex -- removes ANSI colour codes from the CLI output.
      const plain = output.replace(/\u001b\[[0-9;]*m/gu, '');
      base = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(plain)?.[1] ?? '';
      expect(base, output).not.toBe('');
      expect(await fetch(base).then((response) => response.ok, () => false), output).toBe(true);
    }, { timeout: 60_000, interval: 200 });
    config.redirectUri = `${base}/auth/callback`;
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.addCookies([{ name: config.cookieName, value: encodeSession(config,
      { sub: 'oidc-alice', orgId: 'org-acme', roles: [], authTime: 0, exp: 2_000_000_000 }), url: base }]);
    const page = await context.newPage();
    const apiResponse = page.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
    await page.goto(`${base}/org/integrations`);
    expect((await apiResponse).status()).toBe(200);
    await page.locator('.register-row').first().waitFor();
    expect(await page.locator('.register-row').count()).toBe(6);

    await page.getByRole('link', { name: 'Add an integration', exact: true }).click();
    await page.getByRole('heading', { name: 'Add an MCP server' }).waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot({ path: `/tmp/p3-3-source-${width}.png`, fullPage: true });
    }
    await page.getByLabel('Server URL', { exact: true }).fill('https://mcp.example.test/mcp');
    const registrations: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/org/integrations')) registrations.push(request.url()); });
    const registered = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/org/integrations'));
    await page.getByRole('button', { name: 'Discover tools', exact: true }).click();
    expect((await registered).status()).toBe(202);
    await page.reload();
    await page.getByText('Outcome unknown', { exact: false }).waitFor();
    await vi.waitFor(async () => {
      await page.getByRole('button', { name: 'Check status', exact: true }).click();
      expect(await page.getByRole('region', { name: 'Tool inventory' }).count()).toBe(1);
    }, { timeout: 10_000 });
    expect(registrations).toHaveLength(1);
    await page.getByText('2 tools discovered · 0 allowed').waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      const controls = page.locator('oc-mcp-install button, oc-mcp-install input, oc-mcp-install summary');
      for (let i = 0; i < await controls.count(); i++) expect((await controls.nth(i).boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `/tmp/p3-3-review-${width}.png`, fullPage: true });
    }
    remote.status(401);
    await page.getByRole('button', { name: 'Add another server' }).click();
    await page.getByLabel('Server URL', { exact: true }).fill('https://mcp.example.test/protected');
    await page.getByRole('button', { name: 'Discover tools', exact: true }).click();
    function isDiscoveryStatus(response: Response) {
      return response.url().includes('/api/org/integrations/discovery?locator=');
    }
    async function checkProtectedDiscovery() {
      const discovery = page.waitForResponse(isDiscoveryStatus);
      await page.getByRole('button', { name: 'Check status', exact: true }).click();
      const response = await discovery;
      expect(response.status()).toBe(200);
      const status: unknown = await response.json();
      const expected = { state: 'needs_input', reason: 'connection_required' };
      expect(status).toMatchObject(expected);
    }
    await vi.waitFor(checkProtectedDiscovery, { timeout: 10_000 });
    // Wait for Angular to apply the response before checking the message on screen.
    await page.getByText('A scoped validation connection is required.', { exact: false }).waitFor();
    expect(await page.getByRole('region', { name: 'Tool inventory' }).count()).toBe(0);
    await page.getByRole('link', { name: 'Back to integrations' }).click();
    await page.locator('.register-row').first().waitFor();

    const toolsLoaded = page.waitForResponse(r => r.url().endsWith('/odoo/tools'));
    await page.goto(`${base}/org/integrations/odoo/tools`);
    expect((await toolsLoaded).status()).toBe(200);
    await page.getByRole('heading', { name: 'Tools & access' }).waitFor();
    await page.getByRole('group', { name: 'write' }).getByLabel('Allow automatically').check();
    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/odoo/tools'));
    // Angular enables Save after rendering the choice; press() does not wait for enabled controls.
    await page.getByRole('button', { name: 'Save write', disabled: false }).press('Enter');
    expect((await saved).status()).toBe(200);
    await page.getByText('Tool policy saved').waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      const controls = page.locator('.tool-policy label, .tool-policy button');
      for (let i = 0; i < await controls.count(); i++) expect((await controls.nth(i).boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `/tmp/p3-1-tools-${width}.png`, fullPage: true });
    }
    await page.getByRole('link', { name: 'Back to integrations' }).click();
    await page.locator('.register-row').first().waitFor();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('link', { name: 'Models & providers', exact: true }).click();
    await page.getByRole('heading', { name: 'Models & providers' }).waitFor();
    expect(await page.locator('#monthly-ceiling').count()).toBe(0);
    const organisationNavigation = page.getByRole('navigation', {
      name: 'Organisation settings', exact: true,
    });
    const spendingLink = organisationNavigation.getByRole('link', { name: 'Spending', exact: true });
    await spendingLink.click();
    await page.getByRole('heading', { name: 'Spending', exact: true }).waitFor();
    await page.getByLabel('Monthly ceiling (euro cents)').fill('30000');
    const budgetSaved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/org/models'));
    await page.getByRole('button', { name: 'Save budget' }).click();
    expect((await budgetSaved).status()).toBe(200);
    await page.getByText('Budget saved').waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      const controls = page.locator('oc-spending input, oc-spending select, oc-spending button');
      for (let i = 0; i < await controls.count(); i++) expect((await controls.nth(i).boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `/tmp/p3-13-budgets-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await page.locator('.register-row').first().waitFor();

    await page.setViewportSize({ width: 390, height: 900 });
    const allTab = page.getByRole('tab', { name: /^All/ });
    await allTab.focus();
    await allTab.press('End');
    await focused(page, 'integrations-tab-review');
    await page.waitForFunction(
      `document.getElementById('integrations-panel')?.getAttribute('aria-labelledby') === 'integrations-tab-review'`,
      undefined, { timeout: 5_000 });
    await page.getByRole('tab', { name: /^Pending review/ }).press('Home');
    await focused(page, 'integrations-tab-all');
    await page.getByRole('tab', { name: /^All/ }).press('ArrowRight');
    await focused(page, 'integrations-tab-attention');
    await page.getByRole('tab', { name: /^All/ }).click();
    // Angular renders after the click; wait until All owns the tab stop before pressing Tab.
    await page.waitForFunction(
      `document.getElementById('integrations-tab-all')?.getAttribute('tabindex') === '0'`,
      undefined, { timeout: 5_000 });
    await page.getByRole('tab', { name: /^All/ }).press('Tab');
    await focused(page, 'integration-search');
    await page.keyboard.press('Tab');
    await focused(page, 'integrations-panel');

    expect(await page.getByRole('link', { name: 'Add an integration' }).getAttribute('href'))
      .toBe('/org/integrations/new');
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
      await focused(page, 'refresh-integrations');
      expect(await refresh.getAttribute('aria-disabled')).toBe('true');
      await page.getByText(/Showing what we loaded at 09:40/).waitFor({ timeout: 5_000 });
      expect(await page.locator('.register-row').count()).toBe(6);

      const firstRead = await context.newPage();
      const firstFailure = firstRead.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
      await firstRead.goto(`${base}/org/integrations`);
      expect((await firstFailure).status()).toBe(503);
      await firstRead.getByRole('status').getByText(
        'The organisation register is unavailable.',
      ).waitFor();
      await firstRead.getByText("Couldn't load the integrations list.", {
        exact: true,
      }).waitFor();
      const retryFailure = firstRead.waitForResponse((response) => response.url().endsWith('/api/org/integrations'));
      await firstRead.getByRole('button', { name: 'Refresh list' }).click();
      await firstRead.getByText('Refreshing the integrations list…').waitFor();
      expect(await firstRead.getByText('No integrations yet').count()).toBe(0);
      expect(await firstRead.getByText('0 integrations').count()).toBe(0);
      expect((await retryFailure).status()).toBe(503);
      expect(await firstRead.getByText('No integrations yet').count()).toBe(0);
      expect(await firstRead.getByText('0 integrations').count()).toBe(0);
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
    await page.getByRole('heading', {
      name: 'You no longer have access to Integrations',
    }).waitFor();
    expect(await page.getByText('Ask an Owner or Admin').count()).toBe(1);
    expect(await page.locator('.access-state button').count()).toBe(0);
    expect(await page.locator('.register-row').count()).toBe(0);

    const unavailablePage = await context.newPage();
    await fga.pause();
    try {
      const unavailableRead = unavailablePage.waitForResponse((response) =>
        response.url().endsWith('/api/org/integrations'));
      await unavailablePage.goto(`${base}/org/integrations`);
      expect((await unavailableRead).status()).toBe(503);
      await unavailablePage.getByRole('status').getByText(
        'The organisation register is unavailable.',
      ).waitFor();
      await unavailablePage.getByText("Couldn't load the integrations list.", {
        exact: true,
      }).waitFor();
      expect(await unavailablePage.locator('.register-row').count()).toBe(0);
      expect(await unavailablePage.getByText(/Showing what we loaded/).count()).toBe(0);
    } finally {
      await fga.resume();
      await unavailablePage.close();
    }
    await context.close();
  } finally {
    config.redirectUri = originalRedirect;
    await remote.close();
    await browser.close();
    web.kill('SIGTERM');
    const hardKill = setTimeout(() => web.kill('SIGKILL'), 5_000);
    await webExited;
    clearTimeout(hardKill);
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

/** Wait until the element with this id has focus; Angular renders after the key event. */
async function focused(page: Page, id: string): Promise<void> {
  // A string expression runs in the browser; this test file has no DOM types.
  await page.waitForFunction(`document.activeElement?.id === ${JSON.stringify(id)}`, undefined, { timeout: 5_000 });
}


it('restricts the model and spending read to projected owners and admins', async () => {
  for (const [sub, status] of [['oidc-alice', 200], ['oidc-amina', 200], ['oidc-bob', 403], ['oidc-mallory', 403]] as const) {
    const reply = await app.inject({ method: 'GET', url: '/api/org/models', headers: headers(sub) });
    expect(reply.statusCode).toBe(status);
    if (status === 200) expect(reply.json()).toMatchObject({ todayCents: 0, monthCents: 0, dailyCeilingCents: 2000,
      ceilingCents: 20000, shortContextTokens: 272000,
      taskRouting: { chat_turn: { model: 'gpt-6.1-sol' }, deep_analysis: { model: 'gpt-6-astra' }, summary: { model: 'gpt-6-luna' } },
      models: [
        { id: 'gpt-6-astra', default: false }, { id: 'gpt-6.1-sol', default: true }, { id: 'gpt-6-luna', default: false },
        { id: 'gpt-6-sol' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-luna' },
        { id: 'gpt-5.5' }, { id: 'gpt-5.5-pro' }, { id: 'gpt-5.4' }, { id: 'gpt-5.4-pro' },
        { id: 'gpt-5-nano', default: false, retired: true, priceTableId: 'openai-2026-10-02-eur95' },
        { id: 'gpt-5-mini', default: false, retired: true, priceTableId: 'openai-2026-10-02-eur95' },
      ] });
  }
  expect((await app.inject({ method: 'GET', url: '/api/org/models' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/org/models', headers: headers('oidc-alice', 'other') })).statusCode).toBe(403);
});

it('saves a reviewed connection revision policy through one conditional event and replays it', async () => {
  await mcp('odoo', 'mcp.server_discovered', { toolCount: 2, schemaDigest: 'a'.repeat(64),
    connectionId: 'installed-odoo', accountMode: 'none', tools: [
      { name: 'read', revision: 'a'.repeat(64), reviewed: true, readOnly: true, costCents: 0 },
      { name: 'write', revision: 'b'.repeat(64), reviewed: true, readOnly: false, costCents: 0 },
    ] });
  await runner.run(mcpCatalogue);
  const url = '/api/org/integrations/odoo/tools';
  const read = await app.inject({ url, headers: headers('oidc-alice') });
  expect(read.statusCode).toBe(200);
  const state = read.json<{ sequence: number; tools: { name: string; mode: string; suggestion: string }[] }>();
  expect(state.tools).toMatchObject([{ name: 'read', mode: 'block', suggestion: 'allow' }, { name: 'write', mode: 'block', suggestion: 'ask' }]);
  const payload = { commandId: 'policy-write', expectedSequence: state.sequence, connectionId: 'installed-odoo', toolName: 'write', toolRevision: 'b'.repeat(64), mode: 'allow' };
  for (const sub of ['oidc-bob', 'oidc-mallory']) expect((await app.inject({ method: 'POST', url,
    headers: { ...headers(sub), origin: new URL(config.redirectUri).origin }, payload })).statusCode).toBe(403);
  const save = () => app.inject({ method: 'POST', url, headers: { ...headers('oidc-amina'), origin: new URL(config.redirectUri).origin }, payload });
  expect((await save()).statusCode).toBe(200);
  expect((await save()).statusCode).toBe(200);
  await runner.run(mcpCatalogue);
  const before = await catalogue.tools('test', 'odoo');
  expect(before.tools[1]?.mode).toBe('allow');
  await runner.rebuild(mcpCatalogue);
  expect(await catalogue.tools('test', 'odoo')).toEqual(before);
  const events = [];
  for await (const row of nats.store.readStream('mcp-odoo')) if (row.event.commandId === 'policy-write') events.push(row);
  expect(events).toHaveLength(1);
  const race = await Promise.all(['ask', 'block'].map((mode, i) => app.inject({ method: 'POST', url,
    headers: { ...headers('oidc-alice'), origin: new URL(config.redirectUri).origin },
    payload: { ...payload, commandId: `policy-race-${i}`, expectedSequence: before.sequence, mode } })));
  expect(race.map(r => r.statusCode).sort()).toEqual([200, 409]);
  const latest = race.find(r => r.statusCode === 200)!.json<{ policy: { sequence: number } }>().policy.sequence;
  for (const patch of [{ connectionId: 'foreign' }, { toolRevision: 'c'.repeat(64) }, { toolName: '__proto__' }]) {
    expect((await app.inject({ method: 'POST', url, headers: { ...headers('oidc-alice'), origin: new URL(config.redirectUri).origin },
      payload: { ...payload, commandId: 'bad-policy', expectedSequence: latest, ...patch } })).statusCode).toBe(409);
  }
  expect((await app.inject({ method: 'POST', url, headers: { ...headers('oidc-alice'), origin: 'https://foreign.test' }, payload })).statusCode).toBe(403);
});


async function retriesBudgetDuringIamLag() {
  const changed = fixture('member.role_changed', 'member-alice', {
    memberId: 'alice', previousRole: 'owner', newRole: 'admin', changedBy: 'amina',
  });
  await append(changed);
  const payload = { commandId: 'budget-iam-pending', expectedSequence: actor.state.sequence,
    scope: 'global', ceilingCents: 30000 };
  const requestHeaders = { ...headers('oidc-alice'),
    origin: new URL(config.redirectUri).origin };
  const options = { method: 'POST' as const, url: '/api/org/models',
    headers: requestHeaders, payload };
  const before = await nats.store.head('budget-test');
  expect((await app.inject(options)).statusCode).toBe(503);
  expect(await nats.store.head('budget-test')).toBe(before);
  await authorisation.handler.handle(changed, pgDb(dbs.queue));
  expect((await app.inject(options)).statusCode).toBe(200);
}
it('budget commands are retryable while a current role waits for its IAM receipt',
  retriesBudgetDuringIamLag);

it('lets Owner and Admin configure the one budget actor, refuses others and replays every ceiling', async () => {
  const url = '/api/org/models';
  const payload = { commandId: 'budget-global', expectedSequence: actor.state.sequence, scope: 'global', ceilingCents: 30000, dailyCeilingCents: 2000, defaultPayingGroupId: 'personal-default' };
  for (const sub of ['oidc-bob', 'oidc-mallory']) expect((await app.inject({ method: 'POST', url, headers: { ...headers(sub), origin: new URL(config.redirectUri).origin }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url, headers: headers('oidc-alice'), payload })).statusCode).toBe(403);
  for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect((await app.inject({ method: 'POST', url, headers: { ...headers('oidc-alice'), origin: new URL(config.redirectUri).origin }, payload: { ...payload, ceilingCents: bad } })).statusCode).toBe(400);
  const save = (sub: string, body: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { ...headers(sub), origin: new URL(config.redirectUri).origin, 'content-type': 'application/json' } });
  expect((await save('oidc-alice', payload)).statusCode).toBe(200);
  expect((await save('oidc-alice', payload)).statusCode).toBe(200);
  for (const scope of ['paying_group', 'assistant'] as const) {
    expect((await save('oidc-amina', { commandId: `budget-${scope}`, expectedSequence: actor.state.sequence, scope, scopeId: scope === 'assistant' ? 'personal-alice' : 'sales', ceilingCents: 1000 })).statusCode).toBe(200);
  }
  const before = actor.state;
  await runner.rebuild(budgets); expect(await readBudget(pgDb(dbs.queue), 'test')).toEqual(before);
  const reply = await app.inject({ url, headers: headers('oidc-amina') });
  expect(reply.json()).toMatchObject({ budget: { defaultPayingGroupId: 'personal-default', ceilings: [{ scope: 'paying_group', scopeId: 'sales', ceilingCents: 1000 }, { scope: 'assistant', scopeId: 'personal-alice', ceilingCents: 1000 }] } });
  const race = await Promise.all(['first', 'second'].map(commandId => save('oidc-alice', { ...payload, commandId, expectedSequence: actor.state.sequence, ceilingCents: 40000 })));
  expect(race.map(r => r.statusCode).sort()).toEqual([200, 409]);
  expect((await fetch(`${decision.url}/budgets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status).toBe(403);
  const token = await tokens.budget({ silo: 'test', memberId: 'alice', commandDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
  expect((await fetch(`${decision.url}/budgets`, { method: 'POST', headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, ceilingCents: 1 }) })).status).toBe(403);
  const eventHead = await nats.store.head();
  await append(fixture('member.role_changed', 'member-alice', { memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'amina' }));
  expect((await save('oidc-alice', { ...payload, commandId: 'stale-admin', expectedSequence: actor.state.sequence })).statusCode).toBe(403);
  expect(await nats.store.head()).toBe(eventHead + 1);

});


it.each(['computer', 'membership', 'expired'] as const)('keeps budget edit authority scoped and fresh during %s changes', async change => {
  const configure = actor.configure.bind(actor);
  const intercepted = vi.spyOn(actor, 'configure').mockImplementation(async (...args) => {
    if (change === 'computer') await append(fixture('computer.turn_closed', 'computer-personal-alice', { assistantId: 'personal-alice', computerId: 'computer-alice' }));
    if (change === 'membership') await append(fixture('member.role_changed', 'member-alice', { memberId: 'alice', previousRole: 'owner', newRole: 'member', changedBy: 'amina' }));
    if (change === 'expired') await delay(2100);
    return configure(...args);
  });
  try {
    const budgetHead = await nats.store.head('budget-test');
    const reply = await app.inject({ method: 'POST', url: '/api/org/models',
      headers: { ...headers('oidc-alice'), origin: new URL(config.redirectUri).origin },
      payload: { commandId: `budget-during-${change}`, expectedSequence: actor.state.sequence, scope: 'global', ceilingCents: 30000 } });
    expect(reply.statusCode).toBe(change === 'computer' ? 200 : 503);
    expect(actor.state.ceilingCents).toBe(change === 'computer' ? 30000 : 20000);
    if (change !== 'computer') expect(await nats.store.head('budget-test')).toBe(budgetHead);
  } finally { intercepted.mockRestore(); }
});


it('serves safe admin changes and requester actions while refusing foreign users, silos and stale authority', async () => {
  const created = fixture('conversation.created', 'conversation-private', { conversationId: 'private', assistantId: 'personal-alice', createdBy: 'alice', mode: 'agent_session' });
  await append(created); await authorisation.handler.handle(created, pgDb(dbs.queue));
  await append(fixture('decision.recorded', 'decision-safe-request', { requestId: 'safe-request', conversationId: 'private', turnId: 'turn', requesterId: 'alice',
    outcome: 'deny', reason: 'request_refused' }));
  await append(fixture('approval.decided', 'approval-private', { reason: 'private-approval-canary' }));
  await append(fixture('message.posted', 'conversation-private-text', { ciphertext: Buffer.from('private-text-canary').toString('base64') }));
  await runner.run(auditTrail);
  const url = '/api/conversations/private/history';
  for (const [sub, status] of [['oidc-alice', 200], ['oidc-amina', 403], ['oidc-bob', 403], ['oidc-mallory', 403]] as const) {
    const response = await app.inject({ url, headers: headers(sub) });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain('canary');
    if (status === 200) expect(response.json()).toMatchObject({ rows: [{ requestId: 'safe-request', decision: 'deny', outcome: 'not_dispatched' }] });
  }
  for (const [sub, status] of [['oidc-alice', 200], ['oidc-amina', 200], ['oidc-bob', 403]] as const) {
    const response = await app.inject({ url: '/api/org/history', headers: headers(sub) });
    expect(response.statusCode).toBe(status); expect(response.body).not.toContain('canary');
  }
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect((await app.inject({ url, headers: headers('oidc-alice', 'foreign') })).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/org/history?arguments=raw-canary', headers: headers('oidc-alice') })).statusCode).toBe(400);
  const readStream = nats.store.readStream.bind(nats.store);
  const scoped = vi.spyOn(nats.store, 'readStream').mockImplementation((subject, ...args) => {
    expect(subject).not.toMatch(/[* >]/u); return readStream(subject, ...args);
  });
  try { expect((await app.inject({ url, headers: headers('oidc-alice') })).statusCode).toBe(200); } finally { scoped.mockRestore(); }
  await append(fixture('member.removed', 'member-alice', { memberId: 'alice' }));
  // Refuse without waiting for OpenFGA's projection.
  expect((await app.inject({ url, headers: headers('oidc-alice') })).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/org/history', headers: headers('oidc-alice') })).statusCode).toBe(403);
});

it('never logs private audit filters, tokens or dependency error bodies', async () => {
  const { Writable } = await import('node:stream');
  let logs = '';
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { logs += chunk.toString(); callback(); } });
  vi.stubEnv('LOG_LEVEL', 'info');
  const logged = buildServer(config, { logDestination: sink, audit: { silo: 'test', store: nats.store, db: pgDb(dbs.queue), feed, binding: authorisation.binding } });
  async function* failEventRead() {
    const failure = new Error('private-dependency-canary');
    const rejectedRead = Promise.reject(failure);
    yield await rejectedRead;
  }
  const failed = vi.spyOn(nats.store, 'readStream').mockImplementation(failEventRead);
  try {
    const reply = await logged.inject({ url: '/api/org/history', headers: { ...headers('oidc-alice'), authorization: 'Bearer private-bearer-canary' } });
    expect(reply.statusCode).toBe(503); expect(reply.body).not.toContain('canary');
    const invalid = await logged.inject({ url: '/api/org/history?arguments=private-arguments-canary&review=private-review-canary', headers: headers('oidc-alice') });
    expect(invalid.statusCode).toBe(400);
    await logged.inject({ url: '/api/conversations/private-conversation-canary/history?requestId=private-request-canary', headers: headers('oidc-alice') });
    expect(logs).not.toContain('canary');
  } finally { failed.mockRestore(); await logged.close(); vi.unstubAllEnvs(); }
});

it('registers a remote source once and restores its stable change reference through status and replay', async () => {
  const payload = { locator: 'https://new.example.test/mcp' };
  const url = '/api/org/integrations';
  const send = (sub: string) => app.inject({ method: 'POST', url, payload,
    headers: { ...headers(sub), origin: new URL(config.redirectUri).origin } });
  expect((await send('oidc-bob')).statusCode).toBe(403);
  const first = await send('oidc-alice');
  expect(first.statusCode).toBe(202);
  const change = first.json<{ serverId: string; changeRef: string }>();
  expect(change.changeRef).toMatch(/^chg_/u);
  expect((await send('oidc-alice')).json()).toEqual(change);
  const status = () => app.inject({ url: `${url}/${change.serverId}/discovery`, headers: headers('oidc-alice') });
  expect((await status()).json()).toMatchObject({ ...change, state: 'checking' });
  await runner.run(mcpCatalogue);
  const before = await catalogue.rows('test');
  expect(before.filter(r => r.serverId === change.serverId)).toHaveLength(1);
  await runner.rebuild(mcpCatalogue);
  expect(await catalogue.rows('test')).toEqual(before);
  const rows = [];
  for await (const row of nats.store.readStream(`mcp-${change.serverId}`)) rows.push(row);
  expect(rows).toHaveLength(1);
});


it('refuses unsafe remote sources and reconciles uncertain concurrent registration without another append', async () => {
  const url = '/api/org/integrations';
  const admin = { ...headers('oidc-alice'), origin: new URL(config.redirectUri).origin };
  expect((await app.inject({ method: 'POST', url, payload: { locator: 'https://public.test/' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url, headers: headers('oidc-alice'), payload: { locator: 'https://public.test/' } })).statusCode).toBe(403);
  const head = await nats.store.head();
  for (const locator of ['http://public.test/mcp', 'https://user:secret@public.test/', 'https://public.test/?key=secret',
    'https://public.test/#secret', 'https://127.0.0.1/', 'https://[2001:4860::8888]/', 'https://public.test/\n', 'not a URL']) {
    const reply = await app.inject({ method: 'POST', url, headers: admin, payload: { locator } });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toEqual({ status: 'invalid_request' });
  }
  const lookup = `${url}/discovery?locator=${encodeURIComponent('https://race.example.test/mcp')}`;
  expect((await app.inject({ url: lookup, headers: admin })).statusCode).toBe(404);
  expect(await nats.store.head()).toBe(head);
  const results = await Promise.all(['oidc-alice', 'oidc-amina', 'oidc-alice', 'oidc-amina'].map(sub => app.inject({ method: 'POST', url,
    headers: { ...headers(sub), origin: admin.origin }, payload: { locator: 'https://race.example.test/mcp' } })));
  expect(results.map(r => r.statusCode)).toEqual([202, 202, 202, 202]);
  expect(results[0]!.json()).toEqual(results[1]!.json());
  const stored = await nats.store.head();
  expect(stored).toBe(head + 1);
  expect((await app.inject({ url: lookup, headers: admin })).json()).toMatchObject(results[0]!.json());
  expect(await nats.store.head()).toBe(stored);
});

it('projects protected discovery as Needs input and replays inventory without another network request', async () => {
  const remote = await remoteFixture();
  const worker = installWorker(app, nats.store, 'test', remote.network);
  const admin = { ...headers('oidc-alice'), origin: new URL(config.redirectUri).origin };
  try {
    for (const path of ['public', 'protected']) {
      if (path === 'protected') remote.status(401);
      const response = await app.inject({ method: 'POST', url: '/api/org/integrations', headers: admin, payload: { locator: `https://mcp.example.test/${path}` } });
      const { serverId } = response.json<{ serverId: string }>();
      await worker.discover(serverId);
      await runner.run(mcpCatalogue);
      const status = await app.inject({ url: `/api/org/integrations/${serverId}/discovery`, headers: admin });
      expect(status.json()).toMatchObject({ state: 'needs_input', reason: path === 'public' ? 'pending_review' : 'connection_required' });
      const rows = await catalogue.rows('test');
      expect(rows.find(r => r.serverId === serverId)).toMatchObject({ status: { kind: 'needs_input' }, toolsAllowed: 0 });
      const count = remote.calls.length;
      await runner.rebuild(mcpCatalogue);
      expect(await catalogue.rows('test')).toEqual(rows);
      expect(remote.calls).toHaveLength(count);
      if (path === 'public') expect(await catalogue.tools('test', serverId)).toMatchObject({ published: false, connectionId: null, tools: [{ mode: 'block', reviewed: false }, { mode: 'block', reviewed: false }] });
    }
  } finally { await remote.close(); }
});

it('lists 50 held and settled reservations and reads their details within two seconds', async () => {
  const permits: string[] = [];
  for (let index = 0; index < 50; index++) {
    const permitId = await actor.reserve({ model: 'gpt-6.1-sol', priceTableId: 'openai-2026-10-02-all-eur95',
      computerId: 'computer', assistantId: 'personal-alice', requesterId: 'alice', conversationId: 'private-conversation',
      turnId: 'private-turn', threadId: 'private-thread', payingGroupId: 'personal-default', contextDigest: '0'.repeat(64) }, 10);
    permits.push(permitId);
    await actor.effect(permitId, index < 25 ? undefined : { inputTokens: 1, outputTokens: 1 });
    if (index >= 25) {
      const observed = (await history(nats.store, `effect-${permitId}`, 'test')).find(row => row.event.type === 'effect.observed')!;
      await actor.settleRecorded(permitId, observed.event.id);
    }
  }
  const head = await nats.store.head();
  const started = performance.now();
  const response = await app.inject({ url: '/api/org/effects', headers: headers('oidc-alice') });
  const listMs = performance.now() - started;
  expect(response.statusCode).toBe(200);
  expect(listMs).toBeLessThan(2000);
  expect(response.headers['cache-control']).toBe('no-store');
  const parsedList = effectListResponseSchema.parse(response.json());
  const effects = parsedList.effects;
  expect(effects).toHaveLength(50);
  expect(effects.map(effect => effect.permitId)).toEqual(permits);
  for (const effect of effects.slice(0, 25)) {
    expect(effect).toMatchObject({ state: 'outcome_unknown', settledCents: null, reasons: ['settle_timeout'] });
  }
  for (const effect of effects.slice(25)) {
    expect(effect).toMatchObject({ state: 'settled', settledCents: 1, reasons: [] });
  }
  const detailMs: number[] = [];
  for (const index of [0, 49]) {
    const detailStarted = performance.now();
    const detail = await app.inject({ url: `/api/org/effects/${permits[index]!}`, headers: headers('oidc-amina') });
    detailMs.push(performance.now() - detailStarted);
    expect(detail.statusCode).toBe(200);
    expect(detailMs.at(-1)).toBeLessThan(2000);
    const parsedDetail = effectDetailResponseSchema.parse(detail.json());
    expect(parsedDetail).toMatchObject(effects[index]!);
  }
  expect(await nats.store.head()).toBe(head);
  console.info('Effect HTTP timings (ms)', { listMs, detailMs });
}, 60_000);

it('exposes safe effect evidence to Owner/Admin, refuses other identities and records a resolution without dispatch', async () => {
  const permitId = await actor.reserve({ model: 'gpt-6.1-sol', priceTableId: 'openai-2026-10-02-all-eur95',
    computerId: 'computer', assistantId: 'personal-alice', requesterId: 'alice', conversationId: 'private-conversation',
    turnId: 'private-turn', threadId: 'private-thread', payingGroupId: 'personal-default', contextDigest: '0'.repeat(64) }, 10);
  await actor.effect(permitId);
  const url = `/api/org/effects/${permitId}`;
  const operatorHeaders = headers('oidc-alice');
  const status = await app.inject({ method: 'GET', url, headers: operatorHeaders });
  expect(status.statusCode).toBe(200);
  const body = status.json<{ sequence: number; csrf: string; state: string }>();
  expect(body.state).toBe('outcome_unknown');
  for (const privateValue of ['private-conversation', 'private-turn', 'private-thread', 'requesterId', 'contextDigest', 'authorization']) expect(status.body).not.toContain(privateValue);
  expect((await app.inject({ method: 'GET', url: '/api/org/effects', headers: headers('oidc-amina') })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url, headers: headers('oidc-bob') })).statusCode).toBe(403);
  expect((await app.inject({ method: 'GET', url, headers: headers('oidc-alice', 'other') })).statusCode).toBe(403);
  const payload = { commandId: 'resolve-safe', expectedSequence: body.sequence, outcome: 'released', settledCents: 0,
    evidence: [{ kind: 'dispatch_record', reference: 'dispatch-check-1', digest: 'b'.repeat(64), notDispatched: true }] };
  expect((await app.inject({ method: 'POST', url: `${url}/resolve`, headers: headers('oidc-alice'), payload })).statusCode).toBe(403);
  const head = await nats.store.head('budget-test');
  const resolveHeaders = { ...operatorHeaders, origin: new URL(config.redirectUri).origin, 'x-csrf-token': body.csrf };
  const effectHead = await nats.store.head(`effect-${permitId}`);
  for (const fractional of ['0.99999999999999999', '1.00000000000000001', '1e-324']) {
    const raw = JSON.stringify({ ...payload, outcome: 'settled', settledCents: 1, evidence: [{ kind: 'provider_receipt', reference: 'receipt', digest: 'a'.repeat(64), amountCents: 1 }] }).replace('"settledCents":1', `"settledCents":${fractional}`);
    expect((await app.inject({ method: 'POST', url: `${url}/resolve`, headers: { ...resolveHeaders, 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(400);
    const badReceipt = JSON.stringify({ ...payload, outcome: 'settled', settledCents: 1, evidence: [{ kind: 'provider_receipt', reference: 'receipt', digest: 'a'.repeat(64), amountCents: 1 }] }).replace('"amountCents":1', `"amountCents":${fractional}`);
    expect((await app.inject({ method: 'POST', url: `${url}/resolve`, headers: { ...resolveHeaders, 'content-type': 'application/json' }, payload: badReceipt })).statusCode).toBe(400);
    expect(await nats.store.head(`effect-${permitId}`)).toBe(effectHead);
  }
  expect((await app.inject({ method: 'POST', url: `${url}/resolve`, headers: resolveHeaders, payload })).statusCode).toBe(202);
  expect((await app.inject({ method: 'POST', url: `${url}/resolve`, headers: resolveHeaders, payload })).statusCode).toBe(202);
  expect(await nats.store.head('budget-test')).toBe(head); // The command appends only to the effect stream.
  const after = await app.inject({ method: 'GET', url, headers: headers('oidc-alice') });
  expect(after.json()).toMatchObject({ state: 'resolution_pending', resolution: { outcome: 'released', settledCents: 0 } });
  const resolution = (await history(nats.store, `effect-${permitId}`, 'test')).find(row => row.event.type === 'effect.resolved')!.event;
  await settlementHandler(decision.url).handle(resolution, pgDb(dbs.queue));
  await settlementHandler(decision.url).handle(resolution, pgDb(dbs.queue));
  const completed = await app.inject({ method: 'GET', url, headers: operatorHeaders });
  expect(completed.json()).toMatchObject({ state: 'released', settledCents: 0 });
});

async function readsSlowEffects(view: 'list' | 'detail') {
  const call = {
    model: 'gpt-6.1-sol', priceTableId: 'openai-2026-10-02-all-eur95',
    computerId: 'computer', assistantId: 'personal-alice', requesterId: 'alice',
    conversationId: 'private-conversation', turnId: 'private-turn', threadId: 'private-thread',
    payingGroupId: 'personal-default', contextDigest: '0'.repeat(64),
  };
  const permitId = await actor.reserve(call, 10);
  await actor.effect(permitId);
  const readStream = nats.store.readStream.bind(nats.store);
  type StreamArguments = Parameters<typeof nats.store.readStream>;
  async function* slowBudgetRead(...streamArguments: StreamArguments) {
    if (streamArguments[0] === 'budget-test') {
      await delay(2200);
    }
    yield* readStream(...streamArguments);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(slowBudgetRead);
  let url = '/api/org/effects';
  if (view === 'detail') {
    url = `${url}/${permitId}`;
  }
  try {
    const response = await app.inject({ url, headers: headers('oidc-amina') });
    expect(response.statusCode).toBe(200);
    function isAdminRead(call: StreamArguments) {
      return call[0] === 'member-amina';
    }
    const adminReads = reads.mock.calls.filter(isAdminRead);
    expect(adminReads).toHaveLength(1);
  } finally {
    reads.mockRestore();
  }
}

it.each(['list', 'detail'] as const)(
  'returns the effect %s after a read longer than the write access limit', readsSlowEffects,
);

async function refusesAdminRemovedDuringEffectRead(view: 'list' | 'detail') {
  const call = {
    model: 'gpt-6.1-sol', priceTableId: 'openai-2026-10-02-all-eur95',
    computerId: 'computer', assistantId: 'personal-alice', requesterId: 'alice',
    conversationId: 'private-conversation', turnId: 'private-turn', threadId: 'private-thread',
    payingGroupId: 'personal-default', contextDigest: '0'.repeat(64),
  };
  const permitId = await actor.reserve(call, 10);
  await actor.effect(permitId);
  const readStream = nats.store.readStream.bind(nats.store);
  type StreamArguments = Parameters<typeof nats.store.readStream>;
  let removed = false;
  async function* removeAdminDuringRead(...streamArguments: StreamArguments) {
    yield* readStream(...streamArguments);
    if (streamArguments[0] === 'budget-test' && !removed) {
      removed = true;
      const removal = fixture('member.removed', 'member-amina', {
        memberId: 'amina', removedBy: 'alice',
      });
      await append(removal);
      // Leave OpenFGA and the member table behind to prove the saved removal wins.
    }
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(removeAdminDuringRead);
  let url = '/api/org/effects';
  if (view === 'detail') {
    url = `${url}/${permitId}`;
  }
  try {
    const response = await app.inject({ url, headers: headers('oidc-amina') });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
    expect(response.body).not.toContain(permitId);
  } finally {
    reads.mockRestore();
  }
}

it.each(['list', 'detail'] as const)(
  'refuses the effect %s when the admin is removed during the read',
  refusesAdminRemovedDuringEffectRead,
);
