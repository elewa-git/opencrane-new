import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { approvalCardsSchema, chatFeedSchema } from '@opencrane/protocol';
import { auditTrail, readAudit, conversations, readConversation } from '@opencrane/projections';
import { history, readApproval, decideApproval, ingestUsage } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { fixture } from '@opencrane/models/testing';
async function approvalFixture(stepUp = false) {
  const f = await fixture();
  await f.runner.initialise(conversations);
  await f.runner.run(conversations);
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const app = buildServer(config, { chat: { silo: 'test', store: f.nats.store, db: f.db, keys: f.keys, binding: f.binding,
    feed: { memberId: (_silo, _issuer, sub) => Promise.resolve(sub) } } });
  const headers = (sub = 'alice', authTime = 0, approval?: string) => ({ origin: new URL(config.redirectUri).origin,
    cookie: `${config.cookieName}=${encodeSession(config, { sub, orgId: 'org-test', roles: [], authTime,
      exp: Math.floor(Date.now() / 1000) + 3600, ...(approval ? { stepUpApproval: approval } : {}) })}` });
  await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' });
  const discover = (stepUp: boolean) => f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', connectionId: 'installed', accountMode: 'none', schemaDigest: 'a'.repeat(64), toolCount: 1,
    tools: [{ name: 'write', revision: 'a'.repeat(64), reviewed: true, costCents: 0, review: { action: 'Update order note', consequence: 'The order note changes immediately.', targetArgument: 'order', fields: ['order', 'note', 'amount'], stepUp } }] });
  await discover(stepUp);
  await f.append('mcp-fixture', 'mcp.server_published', { serverId: 'fixture', publishedBy: 'alice' });
  await f.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture', connectionId: 'installed', toolName: 'write', toolRevision: 'a'.repeat(64), mode: 'ask', setBy: 'alice' });
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const event = await f.append(grantStream('mcp_server', 'fixture'), 'grant.given', { resourceType: 'mcp_server', resourceId: 'fixture', granteeId, granteeKind, grantedBy: 'alice' });
    await f.auth.handler.handle(event, f.db);
  }
  function body(args = '{"order":9007199254740993,"note":"hello","amount":1.00e2}') {
    const metadata = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      threadId: 'thread', callId: 'approval-call',
    };
    const encodedMetadata = JSON.stringify(metadata);
    const parameters = `{"name":"write","arguments":${args},"_meta":${encodedMetadata}}`;
    return `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${parameters}}`;
  }
  const call = async (args?: string, extra = {}, raw = body(args)) => {
    const response = await fetch(`http://127.0.0.1:${f.options.port}/mcp/fixture/installed`, { method: 'POST', headers: { ...f.headers,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'write', ...extra }, body: raw });
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
    const statuses = [];
    for (const response of retry) {
      statuses.push(response.status);
    }
    statuses.sort();
    // The loser may fail closed on unavailable authority; single use is the invariant.
    expect(statuses[0]).toBe(200);
    expect([403, 503]).toContain(statuses[1]);
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
    const used = z.object({ permitId: z.string() }).parse(events.find(e => e.type === 'approval.used')!.data);
    const decision = (await history(f.nats.store, `decision-${used.permitId}`, 'test'))[0]!;
    expect(decision.event).toMatchObject({ correlation: { approval: cards[0]!.approvalId },
      data: { requestId: used.permitId, permitId: used.permitId, callId: 'approval-call',
        outcome: 'allow', reason: 'approval_used' } });
    await f.runner.initialise(auditTrail); await f.runner.run(auditTrail);
    const audit = await readAudit(f.db, 'test', { requestId: used.permitId });
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ decision: 'allow', outcome: 'unknown' });
    expect(audit.rows[0]!.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.approval_requested' }), expect.objectContaining({ type: 'approval.decided' }),
      expect.objectContaining({ type: 'approval.used' }), expect.objectContaining({ type: 'decision.recorded', reason: 'Single-use approval consumed' }),
    ]));
    expect(JSON.stringify(audit)).not.toContain('hello');
    await f.runner.rebuild(auditTrail);
    expect(await readAudit(f.db, 'test', { requestId: used.permitId })).toEqual(audit);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

async function refusesMessageDuringAllowAudit() {
  const fixture = await approvalFixture();
  try {
    await fixture.call();
    expect((await fixture.decide()).statusCode).toBe(200);
    const append = fixture.nats.store.append.bind(fixture.nats.store);
    const encrypted = fixture.keys.encrypt('test', 'conversation', 'Withdraw this request');
    const message = {
      conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...encrypted,
    };
    const allowAudit = z.object({
      type: z.literal('decision.recorded'), data: z.object({ outcome: z.literal('allow') }),
    });
    let changed = false;
    async function appendAfterMessage(command: Parameters<typeof append>[0]) {
      const parsedAudit = allowAudit.safeParse(command.event);
      if (parsedAudit.success && !changed) {
        changed = true;
        await fixture.append('conversation-conversation', 'message.posted', message);
      }
      return append(command);
    }
    const auditing = vi.spyOn(fixture.nats.store, 'append');
    auditing.mockImplementation(appendAfterMessage);
    try {
      const response = await fixture.call();
      expect(changed).toBe(true);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(fixture.received()).toBe(0);
    } finally {
      auditing.mockRestore();
    }
  } finally {
    await fixture.close();
  }
}

it('refuses approved work when a message arrives during its allow audit',
  refusesMessageDuringAllowAudit, 40_000);

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

it.each(['rejected', 'expired', 'cancelled', 'changed', 'profile', 'turn_changed', 'revoked', 'lost_ack', 'fence', 'audit', 'audit_fence'])('refuses %s approval with zero upstream effects', async reason => {
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
      const auditing = z.object({ type: z.literal('decision.recorded') }).safeParse(command.event).success;
      if (reason === 'audit' && auditing) return { status: 'unavailable', cause: new Error('Audit unavailable') };
      const result = await append(command);
      if (reason === 'audit_fence' && auditing) {
        await f.append('assistant-assistant', 'assistant.settings_changed', { assistantId: 'assistant', changedBy: 'alice', changedFields: ['active'], active: false });
      }
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
    if (['lost_ack', 'fence', 'audit', 'audit_fence'].includes(reason)) expect(state).toBe('outcome_unknown');
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
    const added = await f.append('participation-conversation', 'participant.added', { conversationId: 'conversation', participantId: 'bob', addedBy: 'alice' });
    await f.auth.handler.handle(added, f.db);
    const bob = await f.read(f.headers('bob'));
    expect(bob.cards).toEqual([]);
    const refused = await f.app.inject({ method: 'POST', url: '/api/conversations/conversation/approvals',
      headers: { ...f.headers('bob', now, approvalId), 'x-csrf-token': bob.csrf },
      payload: { approvalId, decision: 'approved' } });
    expect(refused.statusCode).toBe(403);
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
    async function* changeAfterApprovalRead(...args: Parameters<typeof read>) {
      yield* read(...args);
      const subject = args[0];
      if (subject.startsWith('approval-') && !changed) {
        changed = true;
        const settings = { assistantId: 'assistant', changedBy: 'alice',
          changedFields: ['active'], active: false };
        await f.append('assistant-assistant', 'assistant.settings_changed', settings);
      }
    }
    const race = vi.spyOn(f.nats.store, 'readStream');
    race.mockImplementation(changeAfterApprovalRead);
    try { expect((await f.call()).status).toBe(403); }
    finally { race.mockRestore(); }
    expect(changed).toBe(true);
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
    await f.append('participation-conversation', 'participant.removed', { conversationId: 'conversation', participantId: 'alice', removedBy: 'owner' });
    expect((await f.app.inject({ url: '/api/conversations/conversation/approvals', headers: f.headers() })).statusCode).toBe(403);
    expect(f.received()).toBe(0);
  } finally { await f.close(); }
}, 40_000);

it('decides an approval using only its bound authority streams', async () => {
  const f = await approvalFixture();
  try {
    await f.call();
    const session = f.headers(), { cards, csrf } = await f.read(session);
    const approvalId = cards[0]!.approvalId;
    const read = vi.spyOn(f.nats.store, 'readStream');
    const head = vi.spyOn(f.nats.store, 'head');
    const subscribe = vi.spyOn(f.nats.store, 'subscribe');
    try {
      const response = await f.app.inject({ method: 'POST', url: '/api/conversations/conversation/approvals',
        headers: { ...session, 'x-csrf-token': csrf }, payload: { approvalId, decision: 'approved' } });
      expect(response.statusCode, response.body).toBe(200);
      const relevant = new Set(['ownership-test', 'member-alice', 'assistant-assistant', 'computer-assistant', 'conversation-conversation', 'participation-conversation',
        'mcp-fixture', grantStream('mcp_server', 'fixture'), `approval-${approvalId}`]);
      expect(read.mock.calls.map(([subject]) => subject).filter(subject => !relevant.has(subject))).toEqual([]);
      expect(head.mock.calls.flatMap(([subject]) => subject === undefined || relevant.has(subject) ? [] : [subject])).toEqual([]);
      expect(subscribe).not.toHaveBeenCalled();
    } finally { read.mockRestore(); head.mockRestore(); subscribe.mockRestore(); }
    expect((await f.call()).status).toBe(200);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

async function permissionResponseProxy(
  setup: Awaited<ReturnType<typeof approvalFixture>>,
  afterAnswer: () => Promise<void>,
) {
  const originalUrl = setup.binding.apiUrl;
  let answered = false;
  async function forward(request: import('node:http').IncomingMessage,
    reply: import('node:http').ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected proxy body');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    const response = await fetch(originalUrl + request.url, {
      method: request.method ?? 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const text = await response.text();
    if (request.url?.endsWith('/check') && !answered) {
      const check = z.object({ tuple_key: z.object({ relation: z.string() }) }).parse(
        JSON.parse(body));
      if (check.tuple_key.relation === 'read') {
        answered = true;
        await afterAnswer();
      }
    }
    reply.writeHead(response.status, { 'content-type': 'application/json' });
    reply.end(text);
  }
  function handle(request: import('node:http').IncomingMessage,
    reply: import('node:http').ServerResponse) {
    void forward(request, reply).catch(fail);
    function fail(error: unknown) {
      reply.writeHead(500);
      reply.end(String(error));
    }
  }
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy address');
  setup.binding.apiUrl = `http://127.0.0.1:${address.port}`;
  async function close() {
    setup.binding.apiUrl = originalUrl;
    server.close();
    await once(server, 'close');
  }
  return { close };
}

// A removal receipt must not turn a stale permission answer into a new baseline.
const refusesRemovalAfterPermission = async (kind: 'member' | 'participant', applied: boolean) => {
    const setup = await approvalFixture();
    try {
      await setup.call();
      let removed = false;
      async function removeAfterPermission() {
        removed = true;
        let removal;
        if (kind === 'member') {
          removal = await setup.append('member-alice', 'member.removed', {
            memberId: 'alice', removedBy: 'owner',
          });
        } else {
          removal = await setup.append('participation-conversation', 'participant.removed', {
            conversationId: 'conversation', participantId: 'alice', removedBy: 'owner',
          });
        }
        if (applied) await setup.auth.handler.handle(removal, setup.db);
      }
      const proxy = await permissionResponseProxy(setup, removeAfterPermission);
      try {
        const response = await setup.app.inject({
          url: '/api/conversations/conversation/approvals', headers: setup.headers(),
        });
        expect(removed).toBe(true);
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.body).not.toContain('9007199254740993');
        expect(response.body).not.toContain('hello');
      } finally {
        await proxy.close();
      }
    } finally {
      await setup.close();
    }
  };
it.each([
  ['member', false],
  ['member', true],
  ['participant', false],
  ['participant', true],
] as const)('hides approval cards when %s removal follows IAM (receipt applied: %s)',
  refusesRemovalAfterPermission, 40_000);

const preservesApprovalDeadline = async () => {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const started = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
    function expireAfterPermission() {
      clock.mockReturnValue(started + 2001);
      return Promise.resolve();
    }
    const proxy = await permissionResponseProxy(setup, expireAfterPermission);
    try {
      const response = await setup.app.inject({
        url: '/api/conversations/conversation/approvals', headers: setup.headers(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('hello');
    } finally {
      clock.mockRestore();
      await proxy.close();
    }
  } finally {
    await setup.close();
  }
};
it('keeps the approval request deadline when IAM consumes the two-second budget', preservesApprovalDeadline, 40_000);

async function keepsApprovalHistoryOutsideShortCheck() {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const session = setup.headers();
    const { cards, csrf } = await setup.read(session);
    const approvalId = cards[0]!.approvalId;
    const originalRead = setup.nats.store.readStream.bind(setup.nats.store);
    async function* refuseFullHistoryDuringShortCheck(
      subject: string, fromSequence = 1, deadline = Infinity,
    ) {
      for await (const row of originalRead(subject, fromSequence, deadline)) {
        if (subject === 'conversation-conversation' && fromSequence === 1 &&
            row.event.type !== 'conversation.created' &&
            deadline - performance.now() < 2100) {
          throw new Error('Whole conversation read during short access check');
        }
        yield row;
      }
    }
    const read = vi.spyOn(setup.nats.store, 'readStream');
    read.mockImplementation(refuseFullHistoryDuringShortCheck);
    try {
      const response = await setup.app.inject({ method: 'POST',
        url: '/api/conversations/conversation/approvals',
        headers: { ...session, 'x-csrf-token': csrf },
        payload: { approvalId, decision: 'approved' } });
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      read.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it('carries checked approval facts into the short access check without rereading history',
  keepsApprovalHistoryOutsideShortCheck, 40_000);

async function refusesApprovalChangeDuringFinalCheck(type: string) {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const { cards } = await setup.read();
    const approvalId = cards[0]!.approvalId;
    const current = await readApproval(setup.nats.store, 'test', approvalId);
    async function changeDuringFinalCheck() {
      if (type === 'message.posted') {
        const encrypted = setup.keys.encrypt('test', 'conversation', 'Withdraw the request');
        await setup.append('conversation-conversation', type, {
          conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
          contentType: 'text', ...encrypted,
        });
      } else {
        await setup.append('conversation-conversation', type, {
          conversationId: 'conversation', closedBy: 'alice',
        });
      }
    }
    const result = await decideApproval(setup.nats.store, 'test', approvalId,
      'alice', 'approved', true, changeDuringFinalCheck, current);
    expect(result.status).toBe('conflict');
    const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it.each(['message.posted', 'conversation.closed'])(
  'refuses an approval when %s arrives during its final access check',
  refusesApprovalChangeDuringFinalCheck, 40_000);

async function deniesIncompleteReview() {
  const setup = await approvalFixture();
  try {
    const argumentsText = '{"note":"hello","amount":100}';
    expect((await setup.call(argumentsText)).status).toBe(403);
    const { cards } = await setup.read();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ state: 'requested', missingFields: ['order'],
      canApprove: false, canDeny: true, canDecide: false });
    expect((await setup.decide()).statusCode).toBe(409);
    expect((await setup.call(argumentsText)).status).toBe(403);
    expect((await setup.decide('rejected')).statusCode).toBe(200);
    expect((await setup.read()).cards[0]?.state).toBe('denied');
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it('records missing review fields, blocks approval and still permits requester denial',
  deniesIncompleteReview, 40_000);

async function retriesOnlyVerifiedNonDispatch() {
  const setup = await approvalFixture();
  try {
    await setup.call();
    await setup.decide();
    await setup.closeUpstream();
    expect((await setup.call()).status).toBe(503);
    await setup.restart();
    await ingestUsage(setup.actor, setup.options.usageFile);
    const { cards } = await setup.read();
    expect(cards[0]).toMatchObject({ state: 'outcome_unknown', canRetry: true });
    const retries = await Promise.all([setup.decide('retry'), setup.decide('retry')]);
    function statusCode(response: typeof retries[number]) {
      return response.statusCode;
    }
    const statuses = retries.map(statusCode);
    statuses.sort();
    expect(statuses).toEqual([200, 409]);
    await setup.resumeUpstream();
    const retriedBody = setup.body().replace('approval-call', 'approval-retry');
    expect((await setup.call(undefined, {}, retriedBody)).status).toBe(200);
    expect((await setup.call()).status).toBe(403);
    expect(setup.received()).toBe(1);
    await setup.restart();
    await ingestUsage(setup.actor, setup.options.usageFile);
    await ingestUsage(setup.actor, setup.options.usageFile);
    await setup.runner.run(conversations);
    const feed = await readConversation(setup.db, 'test', 'conversation');
    function isAttempt(row: typeof feed.rows[number]) {
      return row.type === 'tool.dispatch_recorded';
    }
    const attempts = feed.rows.filter(isAttempt);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.data).toMatchObject({ outcome: 'not_dispatched',
      evidence: 'connection_refused', callId: 'approval-call' });
    const firstAttempt = z.object({ logicalRequestId: z.string() }).parse(attempts[0]?.data);
    expect(attempts[1]?.data).toMatchObject({ outcome: 'responded', evidence: 'response_received',
      callId: 'approval-retry',
      logicalRequestId: firstAttempt.logicalRequestId });
    for (const attempt of attempts) {
      expect(Date.parse(attempt.time)).not.toBeNaN();
      expect(attempt.data).not.toHaveProperty('arguments');
    }
    chatFeedSchema.parse({ ...feed, computerState: 'ready' });
  } finally {
    await setup.close();
  }
}
it('permits one unchanged retry only after the gateway proves no dispatch',
  retriesOnlyVerifiedNonDispatch, 40_000);

async function refusesRetryWithoutProof(status: number) {
  const setup = await approvalFixture();
  try {
    await setup.call();
    await setup.decide();
    setup.mcpReply(status, false, '{"error":"Connection refused (os error 111)"}');
    await setup.call();
    await setup.restart();
    await ingestUsage(setup.actor, setup.options.usageFile);
    expect((await setup.read()).cards[0]).toMatchObject({
      state: 'outcome_unknown', canRetry: false,
    });
    expect((await setup.decide('retry')).statusCode).toBe(409);
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}
it.each([503, 504])('does not grant a retry for upstream %s or error text',
  refusesRetryWithoutProof, 40_000);

async function refusesRetryAfterBindingEnds(change: string) {
  const setup = await approvalFixture();
  try {
    await setup.call();
    await setup.decide();
    await setup.closeUpstream();
    await setup.call();
    await setup.restart();
    await ingestUsage(setup.actor, setup.options.usageFile);
    const { cards } = await setup.read();
    expect(cards[0]?.canRetry).toBe(true);
    if (change === 'expiry') {
      const now = new Date(cards[0]!.expiresAt);
      await readApproval(setup.nats.store, 'test', cards[0]!.approvalId, { now });
    } else if (change === 'turn') {
      await setup.append('conversation-conversation', 'agent.turn_stop_requested', {
        conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice',
      });
    } else {
      await setup.append(grantStream('mcp_server', 'fixture'), 'grant.revoked', {
        resourceType: 'mcp_server', resourceId: 'fixture', granteeKind: 'member',
        granteeId: 'alice', revokedBy: 'owner',
      });
    }
    const refused = await setup.decide('retry');
    let expectedStatus = 409;
    if (change === 'grant') expectedStatus = 503;
    expect(refused.statusCode).toBe(expectedStatus);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it.each(['expiry', 'turn', 'grant'])('refuses a verified retry after %s changes',
  refusesRetryAfterBindingEnds, 40_000);
