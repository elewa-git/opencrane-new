import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { approvalCardsSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { fixture } from '@opencrane/models/testing';
async function approvalFixture(stepUp = false) {
  const f = await fixture();
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const app = buildServer(config, { chat: { silo: 'test', store: f.nats.store, db: f.db, keys: f.keys, binding: f.binding,
    feed: { memberId: (_silo, _issuer, sub) => Promise.resolve(sub) } } });
  const headers = (sub = 'alice', authTime = 0, approval?: string) => ({ origin: new URL(config.redirectUri).origin,
    cookie: `${config.cookieName}=${encodeSession(config, { sub, orgId: 'org-test', roles: [], authTime,
      exp: Math.floor(Date.now() / 1000) + 3600, ...(approval ? { stepUpApproval: approval } : {}) })}` });
  await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' });
  const discover = (stepUp: boolean) => f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', connectionId: 'installed', accountMode: 'none', schemaDigest: 'a'.repeat(64), toolCount: 1,
    tools: [{ name: 'write', revision: 'a'.repeat(64), reviewed: true, review: { action: 'Update order note', consequence: 'The order note changes immediately.', targetArgument: 'order', fields: ['order', 'note', 'amount'], stepUp } }] });
  await discover(stepUp);
  await f.append('mcp-fixture', 'mcp.server_published', { serverId: 'fixture', publishedBy: 'alice' });
  await f.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture', connectionId: 'installed', toolName: 'write', toolRevision: 'a'.repeat(64), mode: 'ask', setBy: 'alice' });
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const event = await f.append(grantStream('mcp_server', 'fixture'), 'grant.given', { resourceType: 'mcp_server', resourceId: 'fixture', granteeId, granteeKind, grantedBy: 'alice' });
    await f.auth.handler.handle(event, f.db);
  }
  const body = (args = '{"order":9007199254740993,"note":"hello","amount":1.00e2}') => `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write","arguments":${args}},"_meta":{"io.modelcontextprotocol/protocol-version":"2026-07-28","io.modelcontextprotocol/client-capabilities":{}}}`;
  const call = async (args?: string, extra = {}, raw = body(args)) => {
    const response = await fetch(`http://127.0.0.1:${f.options.port}/mcp/fixture/installed`, { method: 'POST', headers: { ...f.headers,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-tool-name': 'write', ...extra }, body: raw });
    return { status: response.status, text: await response.text() };
  };
  const url = '/api/conversations/conversation/approvals';
  const read = async (session = headers()) => {
    const response = await app.inject({ url, headers: session });
    expect(response.statusCode).toBe(200);
    return z.object({ cards: approvalCardsSchema, csrf: z.string() }).parse(response.json());
  };
  const decide = async (decision = 'approved', session = headers(), patch = {}) => {
    const { cards, csrf } = await read(session);
    return app.inject({ method: 'POST', url, headers: { ...session, 'x-csrf-token': csrf }, payload: { approvalId: cards[0]!.approvalId, decision, ...patch } });
  };
  return { ...f, config, app, headers, read, decide, call, body, discover, close: async () => { await app.close(); await f.close(); } };
}

it('opens one encrypted Ask card and forwards approved lossless bytes once across tabs, retries and restart', async () => {
  const f = await approvalFixture();
  try {
    expect((await f.call()).text).toContain('approvalId');
    expect((await f.call()).status).toBe(403);
    const { cards } = await f.read();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: 'requested', canDecide: true, review: { target: '9007199254740993',
      data: '{"amount":1.00e2,"note":"hello","order":9007199254740993}', destination: 'https://fixture.example.test' } });
    const race = await Promise.all([f.decide(), f.decide()]);
    expect(race.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await f.read()).cards[0]?.state).toBe('approved');
    expect((await f.call(undefined, { 'x-turn-token': await f.sign(f.t, 'decision-service', -1) })).status).toBe(403);
    expect((await f.read()).cards[0]?.state).toBe('approved');
    const renewed = await f.issue();
    const retry = await Promise.all([f.call(undefined, renewed), f.call(undefined, renewed)]);
    expect(retry.map(r => r.status).sort()).toEqual([200, 403]);
    expect(f.received()).toBe(1); expect(f.upstreamBody()).toBe(f.body());
    await f.restart();
    expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1);
    expect((await f.read()).cards[0]?.state).toBe('outcome_unknown');
    const events = [];
    for await (const row of f.nats.store.subscribe()) {
      events.push(row.event);
      if (row.sequence === await f.nats.store.head()) break;
    }
    expect(JSON.stringify(events)).not.toContain('hello');
    expect(events.filter(e => e.type === 'approval.used')).toHaveLength(1);
  } finally { await f.close(); }
}, 40_000);

it.each([
  ['agent.turn_stop_requested', { requestedBy: 'alice' }],
  ['agent.turn_completed', {}],
  ['agent.turn_failed', { reason: 'model_error' }],
])('keeps the current approval after an older turn emits %s, but refuses forwarding when the bound turn closes', async (type, details) => {
  const f = await approvalFixture();
  try {
    expect((await f.call()).status).toBe(403);
    const approvalId = (await f.read()).cards[0]!.approvalId;
    const closeTurn = (turnId: string) => f.append('conversation-conversation', type, { conversationId: 'conversation', turnId, ...details });
    await closeTurn('old-turn');
    expect((await f.read()).cards).toMatchObject([{ approvalId, state: 'requested', canDecide: true }]);
    expect((await f.decide()).statusCode).toBe(200);
    await closeTurn('old-turn');
    expect((await f.read()).cards).toMatchObject([{ approvalId, state: 'approved' }]);
    await closeTurn('turn');
    expect((await f.read()).cards).toMatchObject([{ approvalId, state: 'cancelled', canDecide: false }]);
    expect((await f.call()).status).toBe(403);
    expect(f.received()).toBe(0);
  } finally { await f.close(); }
}, 40_000);

it.each(['rejected', 'expired', 'cancelled', 'changed', 'profile', 'turn_changed', 'revoked', 'lost_ack', 'fence'])('refuses %s approval with zero upstream effects', async reason => {
  const f = await approvalFixture();
  try {
    await f.call(); expect((await f.decide(reason === 'rejected' ? 'rejected' : 'approved')).statusCode).toBe(200);
    if (reason === 'expired') f.advance(86400_001);
    if (reason === 'cancelled') await f.append('conversation-conversation', 'agent.turn_stop_requested', { conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice' });
    if (reason === 'changed') await f.discover(false);
    if (reason === 'turn_changed') await f.append('conversation-conversation', 'agent.turn_started', { conversationId: 'conversation', turnId: 'another-turn', assistantId: 'assistant' });
    if (reason === 'profile') await f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', connectionId: 'installed', accountMode: 'personal', schemaDigest: 'b'.repeat(64), toolCount: 1,
      tools: [{ name: 'write', revision: 'b'.repeat(64), reviewed: true }] });
    if (reason === 'revoked') await f.append(grantStream('mcp_server', 'fixture'), 'grant.revoked', { resourceType: 'mcp_server', resourceId: 'fixture', granteeId: 'alice', revokedBy: 'alice' });
    const append = f.nats.store.append.bind(f.nats.store);
    const fault = vi.spyOn(f.nats.store, 'append').mockImplementation(async command => {
      const result = await append(command);
      if (z.object({ type: z.literal('approval.used') }).safeParse(command.event).success) {
        if (reason === 'lost_ack') throw new Error('Acknowledgement lost after durable append');
        if (reason === 'fence') await f.append('assistant-assistant', 'assistant.settings_changed', { assistantId: 'assistant', changedBy: 'alice', changedFields: ['active'], active: false });
      }
      return result;
    });
    try {
      expect((await f.call()).status).toBeGreaterThanOrEqual(400);
      expect((await f.call()).status).toBeGreaterThanOrEqual(400);
      expect(f.received()).toBe(0);
    } finally { fault.mockRestore(); }
    const state = (await f.read()).cards[0]?.state;
    if (reason === 'rejected') expect(state).toBe('denied');
    if (reason === 'expired') expect(state).toBe('expired');
    if (['cancelled', 'changed', 'profile', 'turn_changed'].includes(reason)) expect(state).toBe('cancelled');
    if (['lost_ack', 'fence'].includes(reason)) expect(state).toBe('outcome_unknown');
  } finally { await f.close(); }
}, 40_000);

it('requires the requester session, CSRF and approval-bound recent OIDC evidence only when policy asks', async () => {
  const f = await approvalFixture(true);
  try {
    await f.call();
    const { cards, csrf } = await f.read(), approvalId = cards[0]!.approvalId;
    expect((await f.app.inject({ url: '/api/conversations/conversation/approvals' })).statusCode).toBe(401);
    for (const headers of [f.headers(), { ...f.headers(), 'x-csrf-token': csrf, origin: 'https://evil.test' }]) {
      expect((await f.app.inject({ method: 'POST', url: '/api/conversations/conversation/approvals', headers, payload: { approvalId, decision: 'approved' } })).statusCode).toBe(403);
    }
    expect((await f.decide('approved', f.headers(), { requesterId: 'bob' })).statusCode).toBe(400);
    expect((await f.decide()).statusCode).toBe(428);
    const now = Math.floor(Date.now() / 1000);
    for (const [age, binding] of [[0, 'b'.repeat(64)], [301, approvalId], [-30, approvalId]] as const) {
      expect((await f.decide('approved', f.headers('alice', now - age, binding))).statusCode).toBe(428);
    }
    const joined = await f.append('member-bob', 'member.joined', { memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'admin' });
    await f.auth.handler.handle(joined, f.db);
    const added = await f.append('conversation-conversation', 'participant.added', { conversationId: 'conversation', participantId: 'bob', addedBy: 'alice' });
    await f.auth.handler.handle(added, f.db);
    expect((await f.read(f.headers('bob'))).cards[0]?.canDecide).toBe(false);
    expect((await f.decide('approved', f.headers('bob', now, approvalId))).statusCode).toBe(403);
    expect((await f.decide('approved', f.headers('alice', now, approvalId))).statusCode).toBe(200);
    expect((await f.call()).status).toBe(200); expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it('refuses hidden or ambiguous arguments and does not use an approval for changed number text', async () => {
  const f = await approvalFixture();
  try {
    for (const args of ['{"order":1,"note":"ok","amount":0,"hidden":"secret"}', '{"order":1,"note":"ok","amount":0,"\\u006eote":"evil"}',
      '{"order":1,"note":{"constructor":1},"amount":0}', '{"order":1,"note":"\\ud800","amount":0}']) expect((await f.call(args)).status).toBe(403);
    for (const raw of [f.body().replace('"jsonrpc":"2.0"', '"jsonrpc":2.0'), f.body().replace('"name":"write"', '"name":123')]) expect((await f.call(undefined, {}, raw)).status).toBe(403);
    expect((await f.read()).cards).toHaveLength(0);
    await f.call(); await f.decide();
    expect((await f.call('{"order":9007199254740993,"note":"hello","amount":100}')).status).toBe(403);
    expect(f.received()).toBe(0);
    expect((await f.call('{"amount":1.00e2,"note":"hello","order":9007199254740993}')).status).toBe(200);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it.runIf(process.env['APPROVAL_BROWSER'] === '1')('sizes every control including step-up at 390px, decides the real gateway card and restores terminal states', async () => {
  const { chromium } = await import('playwright');
  const { members, computers, conversations } = await import('@opencrane/projections');
  const browser = await chromium.launch();
  try {
    for (const [width, stepUp] of [[390, true], [1280, false], [390, false]] as const) {
      const f = await approvalFixture(stepUp);
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      try {
        for (const projection of [members, computers, conversations]) { await f.runner.initialise(projection); await f.runner.run(projection); }
        const root = resolve('apps/web/dist/web/browser');
        f.app.get('/*', async (req, reply) => {
          const path = req.url === '/workspace?conversation=conversation' ? '/index.html' : req.url;
          if (!/^\/[\w./-]+$/u.test(path) || path.includes('..')) return reply.code(404).send();
          return reply.type(({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream').send(await readFile(root + path));
        });
        const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
        f.config.redirectUri = origin + '/auth/callback';
        await page.context().addCookies([{ name: f.config.cookieName, value: f.headers().cookie.slice(f.config.cookieName.length + 1), url: origin }]);
        await f.call();
        await page.goto(`${origin}/workspace?conversation=conversation`);
        await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
        await page.evaluate('document.fonts.ready');
        expect(await page.locator('.approval-ledger').innerText()).toContain('9007199254740993');
        expect(await page.evaluate<boolean>("document.querySelector('.approval').scrollWidth <= document.querySelector('.approval').clientWidth")).toBe(true);
        expect(await page.getByRole('link', { name: 'Sign in again' }).count()).toBe(stepUp ? 1 : 0);
        const controls = await page.locator('.approval button, .approval a[href]').all();
        expect(controls).toHaveLength(stepUp ? 3 : 2);
        for (const control of controls) {
          const box = (await control.boundingBox())!;
          expect(box.width, await control.innerText()).toBeGreaterThanOrEqual(44);
          expect(box.height, await control.innerText()).toBeGreaterThanOrEqual(44);
        }
        if (width === 390) expect((await page.locator('.approve').boundingBox())!.width).toBeGreaterThan(280);
        if (stepUp) continue;
        await mkdir('docs/design/chat/comparison/p3-2', { recursive: true });
        await page.screenshot({ path: `docs/design/chat/comparison/p3-2/requested-${width}.png`, fullPage: true });
        await page.reload(); await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
        await page.route('**/api/conversations/conversation/approvals', route => route.request().method() === 'POST' ? route.abort('connectionfailed') : route.continue());
        await page.getByRole('button', { name: 'Approve', exact: true }).click();
        await page.getByText('Outcome unknown — check status.', { exact: true }).waitFor();
        expect(await page.locator('.approve').isDisabled()).toBe(true);
        await page.unroute('**/api/conversations/conversation/approvals');
        await page.getByRole('button', { name: 'Check status', exact: true }).click();
        await page.getByText('Failed — safe to retry', { exact: true }).waitFor();
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        await page.route('**/api/conversations/conversation/approvals', async route => { if (route.request().method() === 'POST') await gate; await route.continue(); });
        await page.getByRole('button', { name: 'Approve', exact: true }).click();
        await page.getByText('Submitting…', { exact: true }).waitFor();
        release!();

        await page.locator('.approval.terminal').waitFor();
        expect(await page.locator('.approval.terminal').innerText()).toContain('Approved');
        await page.waitForFunction("document.activeElement?.classList.contains('terminal')");
        await page.unroute('**/api/conversations/conversation/approvals');
        await page.reload(); await page.locator('.approval.terminal').waitFor();
        expect(await page.locator('.approve').count()).toBe(0);
        expect((await f.call()).status).toBe(200); expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1);
        await page.reload(); await page.getByRole('region', { name: 'Outcome unknown · approval used' }).waitFor();
        await page.screenshot({ path: `docs/design/chat/comparison/p3-2/used-${width}.png`, fullPage: true });
      } finally { await page.close(); await f.close(); }
    }
  } finally { await browser.close(); }
}, 120_000);

it('fences changed authority before consumption, leaving no upstream effect or consumed approval', async () => {
  const f = await approvalFixture();
  try {
    await f.call(); await f.decide();
    const read = f.nats.store.readStream.bind(f.nats.store);
    let changed = false;
    const race = vi.spyOn(f.nats.store, 'readStream').mockImplementation(async function* (subject) {
      yield* read(subject);
      if (subject.startsWith('approval-') && !changed) {
        changed = true;
        await f.append('assistant-assistant', 'assistant.settings_changed', { assistantId: 'assistant', changedBy: 'alice', changedFields: ['active'], active: false });
      }
    });
    try { expect((await f.call()).status).toBe(403); }
    finally { race.mockRestore(); }
    expect(f.received()).toBe(0);
    expect((await f.read()).cards[0]?.state).toBe('approved');
  } finally { await f.close(); }
}, 40_000);

it('refuses decisions and consumption when the encrypted review cannot be read', async () => {
  const f = await approvalFixture();
  try {
    await f.call();
    const headers = f.headers(), { cards, csrf } = await f.read(headers);
    const unavailable = vi.spyOn(f.keys, 'decrypt').mockImplementation(() => { throw new Error('Key unavailable'); });
    try {
      expect((await f.app.inject({ method: 'POST', url: '/api/conversations/conversation/approvals', headers: { ...headers, 'x-csrf-token': csrf }, payload: { approvalId: cards[0]!.approvalId, decision: 'approved' } })).statusCode).toBe(503);
      expect((await f.call()).status).toBe(403); expect(f.received()).toBe(0);
    } finally { unavailable.mockRestore(); }
    expect((await f.read()).cards[0]?.state).toBe('requested');
  } finally { await f.close(); }
}, 40_000);

it('refuses review reads after conversation access is removed even while OpenFGA lags', async () => {
  const f = await approvalFixture();
  try {
    await f.call();
    await f.append('conversation-conversation', 'participant.removed', { conversationId: 'conversation', participantId: 'alice', removedBy: 'owner' });
    expect((await f.app.inject({ url: '/api/conversations/conversation/approvals', headers: f.headers() })).statusCode).toBe(403);
    expect(f.received()).toBe(0);
  } finally { await f.close(); }
}, 40_000);
