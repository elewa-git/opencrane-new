import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { chromium, type Page, type Route } from 'playwright';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '@opencrane/models';
import { auditTrail, members, connectMemberFeed, pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

function isFocused(element: Element): boolean {
  return element === document.activeElement;
}

async function checkOlderHistory(page: Page, base: string): Promise<void> {
  const recordedAt = new Date().toISOString();
  const memberRecord = { eventId: 'member-event', type: 'member.role_changed', position: 42,
    source: 'authoritative', status: 'recorded', recordedAt, operation: 'role_change' };
  const publicationRecord = { eventId: 'publication-event', type: 'mcp.server_published',
    position: 21, source: 'authoritative', status: 'recorded', recordedAt };
  const firstPage = { rows: [{ id: 'member-change', decision: 'not_recorded',
    outcome: 'recorded', records: [memberRecord] }], nextBefore: 42 };
  const olderPage = { rows: [{ id: 'publication-change', decision: 'not_recorded',
    outcome: 'recorded', records: [publicationRecord] }] };
  async function servePagedHistory(route: Route) {
    const requestUrl = new URL(route.request().url());
    const body = requestUrl.searchParams.has('before') ? olderPage : firstPage;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  }
  await page.route('**/api/org/history?*', servePagedHistory);
  try {
    await page.goto(`${base}/org/history`);
    const memberEntry = page.getByRole('button', { name: /Member role changed/u });
    await memberEntry.waitFor();
    await memberEntry.focus();
    await page.keyboard.press('Tab');
    const older = page.getByRole('button', { name: 'Older history', exact: true });
    expect(await older.evaluate(isFocused)).toBe(true);
    await page.keyboard.press('Enter');
    const publicationEntry = page.getByRole('button', { name: /Organisation change/u });
    await publicationEntry.waitFor();
    expect(await publicationEntry.getByText('Organisation change', { exact: true }).count()).toBe(1);
    expect(await publicationEntry.getByText('Decision: Not recorded · Observation: Change recorded',
      { exact: true }).count()).toBe(1);
    await page.keyboard.press('Shift+Tab');
    expect(await publicationEntry.evaluate(isFocused)).toBe(true);
    await page.keyboard.press('Enter');
    await page.getByRole('dialog').getByRole('heading', { name: 'Organisation change' }).waitFor();
  } finally {
    await page.unrouteAll();
  }
}

it('shows action and change history states at 1280 and 390px with keyboard filters', async () => {
  const fga = await openfga(), dbs = await databases(), nats = await natsFixture();
  const binding = await createStore(fga.apiUrl, 'test'), auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue), config = { ...testAuthConfig(), expectedOrgId: 'org-acme' };
  const runner = new ProjectionRunner(db, nats.store, createLogger('audit-browser', { level: 'silent' }));
  await runner.initialise(members); await runner.initialise(auditTrail);
  const append = async (subject: string, type: string, data: unknown) => {
    const event = { ...envelope('test', subject, type, data), ...(type === 'member.joined' ? { principal: { id: 'oidc-alice', kind: 'human' as const } } : {}) };
    const rows = await history(nats.store, subject, 'test');
    expect((await nats.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 })).status).toBe('appended');
    if (['member.joined', 'assistant.created', 'conversation.created'].includes(type)) await auth.handler.handle(event, db);
  };
  await append('member-alice', 'member.invited', { memberId: 'alice', email: 'alice@example.test', invitedBy: 'installation', role: 'owner', invitationId: 'invite', invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-alice' }, expiresAt: '2026-10-04T00:00:00Z' });
  await append('member-alice', 'member.joined', { memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'owner', invitationId: 'invite' });
  await append('assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' });
  await append('conversation-conversation', 'conversation.created', { conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' });
  await append('decision-request', 'decision.recorded', { requestId: 'request', permitId: 'permit', requesterId: 'alice', conversationId: 'conversation', turnId: 'turn', route: 'model', outcome: 'allow', reason: 'model_allowed', contextDigest: 'a'.repeat(64) });
  await append('approval-private', 'approval.decided', { approvalId: 'private', decision: 'approved', decidedBy: 'alice', reason: 'private-review-canary' });
  await runner.run(members); await runner.run(auditTrail);
  await until(async () => (await auth.conversation('alice', 'conversation', 'read')).allowed);
  const feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  const app = buildServer(config, { audit: { silo: 'test', store: nats.store, db, feed, binding } });
  const target = await app.listen({ host: '127.0.0.1', port: 0 });
  const directory = await mkdtemp(`${tmpdir()}/audit-browser-`), proxy = `${directory}/proxy.json`;
  await writeFile(proxy, JSON.stringify({ '/api': { target, changeOrigin: true, secure: false } }));
  const web = spawn(process.execPath, ['--experimental-strip-types', '--import', resolve('apps/server/test/support/ephemeral-ports.ts'),
    resolve('node_modules/@angular/cli/bin/ng.js'), 'serve', '--prebundle=false', '--host', '127.0.0.1', '--port', '0', '--proxy-config', proxy],
    { cwd: resolve('apps/web'), env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  web.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  web.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = once(web, 'exit'), browser = await chromium.launch({ headless: true });
  try {
    let base = '';
    await vi.waitFor(async () => {
      expect(web.exitCode, output).toBeNull();
      // eslint-disable-next-line no-control-regex -- the CLI can emit ANSI colour codes.
      base = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/u.exec(output.replace(/\u001b\[[0-9;]*m/gu, ''))?.[1] ?? '';
      expect(base, output).not.toBe(''); expect(await fetch(base).then(r => r.ok, () => false)).toBe(true);
    }, { timeout: 60_000, interval: 200 });
    const context = await browser.newContext();
    await context.addCookies([{ name: config.cookieName, value: encodeSession(config, { sub: 'oidc-alice', orgId: 'org-acme', roles: [], authTime: 0, exp: 2_000_000_000 }), url: base }]);
    const page = await context.newPage();
    const readStream = nats.store.readStream.bind(nats.store);
    type StreamArguments = Parameters<typeof nats.store.readStream>;
    async function* readAuditStream(...streamArguments: StreamArguments) {
      const [subject, fromSequence, deadline] = streamArguments;
      if (subject === 'conversation-conversation') {
        throw new Error('Audit history must not read the conversation event stream');
      }
      yield* readStream(subject, fromSequence, deadline);
    }
    const eventReads = vi.spyOn(nats.store, 'readStream').mockImplementation(readAuditStream);
    try {
      for (const [view, path] of [['action', '/history/conversation'], ['change', '/org/history']] as const) {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          let release!: () => void;
          const held = new Promise<void>(resolve => { release = resolve; });
          await page.route('**/api/**/history*', async route => { await held; await route.continue(); });
          await page.goto(`${base}${path}`);
          await page.getByText('Loading history…').waitFor();
          await page.screenshot({ path: `/tmp/p3-19-${view}-loading-${width}.png`, fullPage: true });
          release(); await page.unrouteAll({ behavior: 'wait' });
          await page.getByText('Observation: Outcome unknown', { exact: false }).waitFor();
          expect(await page.locator('body').innerText()).not.toContain('canary');
          expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
          const controls = page.locator('oc-audit button, oc-audit input, oc-audit select');
          for (let i = 0; i < await controls.count(); i++) expect((await controls.nth(i).boundingBox())?.height).toBeGreaterThanOrEqual(44);
          await page.screenshot({ path: `/tmp/p3-19-${view}-unknown-${width}.png`, fullPage: true });
          if (view === 'change') {
            await page.getByRole('searchbox', { name: 'Safe reference' }).fill('missing-reference');
            await page.getByRole('button', { name: 'Search' }).focus();
            await page.keyboard.press('Enter');
            await page.getByText('No entries match missing-reference.', { exact: true }).waitFor();
            await page.screenshot({ path: `/tmp/p3-19-${view}-empty-${width}.png`, fullPage: true });
          }
          await page.route('**/api/**/history*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"private-error-canary"}' }));
          if (view === 'change') {
            await page.getByRole('button', { name: 'Search' }).press('Enter');
          } else {
            await page.goto(`${base}${path}`);
          }
          await page.getByText('History unavailable.', { exact: false }).waitFor();
          expect(await page.locator('body').innerText()).not.toContain('canary');
          expect(await page.getByText('No entries match missing-reference.',
            { exact: true }).count()).toBe(0);
          await page.screenshot({ path: `/tmp/p3-19-${view}-unavailable-${width}.png`, fullPage: true });
          await page.unrouteAll();
        }
      }
      await checkOlderHistory(page, base);
    } finally {
      eventReads.mockRestore();
    }
    await context.close();
  } finally {
    await browser.close(); web.kill('SIGTERM');
    const kill = setTimeout(() => web.kill('SIGKILL'), 5000); await exited; clearTimeout(kill);
    await app.close(); await feed.close(); await nats.close(); await dbs.close(); await fga.close(); await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
