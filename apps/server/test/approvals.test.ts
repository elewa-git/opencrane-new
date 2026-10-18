import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { parseEventByType } from '@opencrane/events';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { approvalCardsSchema, chatFeedSchema } from '@opencrane/protocol';
import { auditTrail, readAudit, conversations, readConversation } from '@opencrane/projections';
import { envelope, history, readApproval, readToolPolicy, decideApproval,
  ingestUsage } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { catalogueEvidence, fixture, reviewCatalogue,
  toolEvidence } from '@opencrane/models/testing';
async function approvalFixture(stepUp = false) {
  const f = await fixture();
  await f.runner.initialise(conversations);
  await f.runner.run(conversations);
  await f.runner.initialise(auditTrail);
  await f.runner.run(auditTrail);
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const chat = { silo: 'test', store: f.nats.store, db: f.db, keys: f.keys,
    binding: f.binding, feed: { memberId: identity } };
  function identity(_silo: string, _issuer: string, sub: string) {
    return Promise.resolve(sub);
  }
  let app = buildServer(config, { chat });
  async function restartReader() {
    await app.close();
    app = buildServer(config, { chat });
  }
  const headers = (sub = 'alice', authTime = 0, approval?: string) => ({ origin: new URL(config.redirectUri).origin,
    cookie: `${config.cookieName}=${encodeSession(config, { sub, orgId: 'org-test', roles: [], authTime,
      exp: Math.floor(Date.now() / 1000) + 3600, ...(approval ? { stepUpApproval: approval } : {}) })}` });
  await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' });
  const tool = toolEvidence({ name: 'write', reviewed: true, costCents: 0 });
  function discover(stepUp: boolean) {
    const review = { action: 'Update order note', consequence: 'The order note changes immediately.',
      targetArgument: 'order', fields: ['order', 'note', 'amount'], stepUp };
    const reviewedTool = { ...tool, review };
    const catalogue = catalogueEvidence([reviewedTool]);
    const data = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
      ...catalogue };
    return f.append('mcp-fixture', 'mcp.server_discovered', data);
  }
  await discover(stepUp);
  await reviewCatalogue(f);
  await f.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture', connectionId: 'installed', toolName: 'write', toolRevision: tool.revision, mode: 'ask', setBy: 'alice' });
  await f.append('mcp-fixture', 'mcp.server_published', { serverId: 'fixture', publishedBy: 'alice' });
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
  async function close() {
    await app.close();
    await f.close();
  }
  return { ...f, config, restartReader, headers, read, decide, call, body, discover, close,
    get app() {
      return app;
    },
  };
}

async function exactReviewFixture() {
  const setup = await approvalFixture();
  try {
    const rows = await history(setup.nats.store, 'mcp-fixture', 'test');
    function isExactReview(row: (typeof rows)[number]) {
      return row.event.type === 'mcp.server_reviewed';
    }
    const reviews = rows.filter(isExactReview);
    expect(reviews).toHaveLength(1);
    const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    expect(policy).toMatchObject({ published: true,
      tools: [{ name: 'write', reviewed: true, mode: 'ask', costCents: 0 }] });
    const response = await setup.call();
    expect(response.text).toContain('approvalId');
    expect((await setup.read()).cards).toHaveLength(1);
  } finally {
    await setup.close();
  }
}
it('starts approval tests with an exact saved review and a published Ask tool', exactReviewFixture);

const checkOutcomes = ['unchanged', 'failed', 'drift'] as const;
async function checksApprovalAfterRenewal(outcome: typeof checkOutcomes[number]) {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).text).toContain('approvalId');
    const session = setup.headers();
    const { cards, csrf } = await setup.read(session);
    const approvalId = cards[0]!.approvalId;
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    let snapshot = before.catalogue!;
    const checkedAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(checkedAt) + 300_000).toISOString();
    if (outcome === 'failed') {
      const failure = { serverId: 'fixture', outcome, checkedAt, reason: 'discovery_timeout' };
      await setup.append('mcp-fixture', 'mcp.catalogue_checked', failure);
    }
    if (outcome === 'drift') {
      const added = toolEvidence({ name: 'another', reviewed: false, costCents: 0 });
      const evidence = catalogueEvidence([...snapshot.tools!, added]);
      snapshot = { ...snapshot, ...evidence };
      const change = { serverId: 'fixture', previousSchemaDigest: before.catalogue!.schemaDigest,
        newSchemaDigest: snapshot.schemaDigest, catalogue: snapshot };
      await setup.append('mcp-fixture', 'mcp.tools_changed', change);
      const publication = { serverId: 'fixture', publishedBy: 'alice' };
      await setup.append('mcp-fixture', 'mcp.server_published', publication);
    }
    const renewal = { serverId: 'fixture', outcome: 'unchanged', checkedAt, expiresAt,
      schemaDigest: snapshot.schemaDigest };
    await setup.append('mcp-fixture', 'mcp.catalogue_checked', renewal);
    // Leave the approval unread during failure and recovery, as when its worker is stopped.
    await setup.restart();
    const decision = { method: 'POST' as const, url: '/api/conversations/conversation/approvals',
      headers: { ...session, 'x-csrf-token': csrf },
      payload: { approvalId, decision: 'approved' } };
    const response = await setup.app.inject(decision);
    if (outcome === 'unchanged') {
      expect(response.statusCode, response.body).toBe(200);
      expect((await setup.call()).status).toBe(200);
      expect(setup.received()).toBe(1);
    } else {
      expect(response.statusCode, response.body).toBe(409);
      const current = await readApproval(setup.nats.store, 'test', approvalId);
      expect(current.state).toBe('cancelled');
      const cancelReason = outcome === 'drift' ? 'schema_changed' : 'policy_changed';
      expect(current).toHaveProperty('cancelReason', cancelReason);
      const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
      expect(rows.at(-1)?.event.type).toBe('approval.cancelled');
      const headers = { 'x-opencrane-approval-id': approvalId };
      expect((await setup.call(undefined, headers)).status).toBe(403);
      expect(setup.received()).toBe(0);
    }
  } finally {
    await setup.close();
  }
}
it.each(checkOutcomes)('checks waiting approval after %s and renewal',
  checksApprovalAfterRenewal);

it('opens one encrypted Ask card and forwards approved lossless bytes once across tabs, retries and restart', async () => {
  const f = await approvalFixture();
  try {
    expect((await f.call()).text).toContain('approvalId');
    expect((await f.call()).status).toBe(403);
    const { cards } = await f.read();
    expect(cards[0]?.turnId).toBe('turn');
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
    const cause = type === 'agent.turn_stop_requested' ? 'turn_stopped' : 'turn_ended';
    expect((await f.read()).cards[0]).toHaveProperty('cancelReason', cause);
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
    if (reason === 'profile') {
      const tool = toolEvidence({ name: 'write', reviewed: true });
      const catalogue = catalogueEvidence([tool]);
      const data = { serverId: 'fixture', connectionId: 'installed', accountMode: 'personal',
        ...catalogue };
      await f.append('mcp-fixture', 'mcp.server_discovered', data);
    }
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
    const recordedReasons: Record<string, string> = {
      cancelled: 'turn_stopped', changed: 'policy_changed', profile: 'profile_changed',
      turn_changed: 'new_turn', revoked: 'grant_revoked',
    };
    if (recordedReasons[reason]) {
      const card = (await f.read()).cards[0];
      expect(card).toHaveProperty('cancelReason', recordedReasons[reason]);
      expect(card).toHaveProperty('endedAt');
    }
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

it('refuses approval reads and decisions when the stored review digest does not match', async () => {
  const f = await approvalFixture();
  try {
    await f.call();
    const headers = f.headers();
    const { cards, csrf } = await f.read(headers);
    const changedReviewText = JSON.stringify({
      ...cards[0]!.review,
      action: 'Changed after storage',
    });
    const changedReview = vi.spyOn(f.keys, 'decrypt').mockReturnValue(changedReviewText);
    try {
      const read = await f.app.inject({ url: '/api/conversations/conversation/approvals',
        headers });
      expect(read.statusCode).toBe(503);

      const decision = await f.app.inject({
        method: 'POST',
        url: '/api/conversations/conversation/approvals',
        headers: { ...headers, 'x-csrf-token': csrf },
        payload: { approvalId: cards[0]!.approvalId, decision: 'approved' },
      });
      expect(decision.statusCode).toBe(503);
    } finally {
      changedReview.mockRestore();
    }
    expect((await f.read()).cards[0]?.state).toBe('requested');
  } finally {
    await f.close();
  }
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
  relation = 'read',
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
      if (check.tuple_key.relation === relation) {
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
        await setup.append('participation-conversation', type, {
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
    await setup.refuseMcpConnection();
    expect((await setup.call()).status).toBe(503);
    await setup.restart();
    await ingestUsage(setup.actor, setup.options.usageFile);
    const { cards } = await setup.read();
    expect(cards[0]).toMatchObject({ state: 'outcome_unknown', canRetry: true });
    expect(cards[0]).toHaveProperty('usedAt');
    const firstUse = cards[0]!;
    const retries = await Promise.all([setup.decide('retry'), setup.decide('retry')]);
    function statusCode(response: typeof retries[number]) {
      return response.statusCode;
    }
    const statuses = retries.map(statusCode);
    statuses.sort();
    expect(statuses).toEqual([200, 409]);
    const authorised = (await setup.read()).cards[0]!;
    expect(authorised).toHaveProperty('usedAt', firstUse.usedAt);
    expect(authorised).toHaveProperty('decidedAt', firstUse.decidedAt);
    const retriedBody = setup.body().replace('approval-call', 'approval-retry');
    expect((await setup.call(undefined, {}, retriedBody)).status).toBe(200);
    expect((await setup.call()).status).toBe(403);
    expect(setup.received()).toBe(1);
    await setup.restart();
    await ingestUsage(setup.actor, setup.options.usageFile);
    await ingestUsage(setup.actor, setup.options.usageFile);
    const retried = (await setup.read()).cards[0]!;
    expect(retried).toMatchObject({ state: 'outcome_unknown', usedAt: firstUse.usedAt,
      decidedAt: firstUse.decidedAt });
    expect(retried.uses).toHaveLength(2);
    expect(retried.uses?.[0]).toEqual(firstUse.uses?.[0]);
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
    await setup.refuseMcpConnection();
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

async function refusesCallsAndApprovalsDuringControl() {
  const f = await approvalFixture();
  try {
    expect((await f.call()).status).toBe(403);
    const data = { assistantId: 'assistant', computerId: 'computer', generation: 1,
      podUid: 'fixture', conversationId: 'conversation', requesterId: 'alice',
      requesterEventId: 'turn', takeoverId: 'control', leaseId: 'control',
      reason: 'requester_requested', affectedTurnIds: ['turn'] };
    await f.append('computer-assistant', 'takeover.requested', data);
    expect((await f.decide()).statusCode).toBe(409);
    expect((await f.call()).status).toBe(403);
    expect((await f.decide('rejected')).statusCode).toBe(200);
  } finally {
    await f.close();
  }
}
it('refuses a late approval during control but allows explicit denial',
  refusesCallsAndApprovalsDuringControl);

async function refusesApprovedOldTokenDuringControl() {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).status).toBe(403);
    expect((await setup.decide()).statusCode).toBe(200);
    expect((await setup.read()).cards[0]?.state).toBe('approved');
    const oldHeaders = await setup.issue();
    await expect(setup.credentials.check(oldHeaders)).resolves.toMatchObject({
      turn: { turn: 'turn', requester: 'alice' },
    });
    const control = {
      assistantId: 'assistant', computerId: 'computer', generation: 1,
      podUid: 'fixture', conversationId: 'conversation', requesterId: 'alice',
      requesterEventId: 'turn', takeoverId: 'control', leaseId: 'control',
      reason: 'requester_requested', affectedTurnIds: ['turn'],
    };
    await setup.append('computer-assistant', 'takeover.requested', control);

    await expect(setup.credentials.check(oldHeaders))
      .rejects.toThrow('Computer control is pending');
    await expect(setup.issue()).rejects.toThrow('Computer control is pending');
    expect((await setup.call(undefined, oldHeaders)).status).toBe(403);
    expect(setup.received()).toBe(0);
    expect((await setup.read()).cards[0]?.state).toBe('approved');
  } finally {
    await setup.close();
  }
}
it('refuses an approved call with an old token because computer control is pending',
  refusesApprovedOldTokenDuringControl, 40_000);

async function decidesWithoutBudgetHistory() {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).status).toBe(403);
    const readStream = setup.nats.store.readStream.bind(setup.nats.store);
    let budgetReads = 0;
    async function* readApprovalStreams(...args: Parameters<typeof readStream>) {
      if (args[0] === 'budget-test') {
        budgetReads++;
        throw new Error('Unrelated budget history is unavailable');
      }
      yield* readStream(...args);
    }
    const reading = vi.spyOn(setup.nats.store, 'readStream');
    reading.mockImplementation(readApprovalStreams);
    try {
      expect((await setup.decide()).statusCode).toBe(200);
      expect(budgetReads).toBe(0);
    } finally {
      reading.mockRestore();
    }
    expect((await setup.read()).cards[0]?.state).toBe('approved');
    expect((await setup.call()).status).toBe(200);
    expect(setup.received()).toBe(1);
  } finally {
    await setup.close();
  }
}
it('decides an approval without reading unrelated budget history',
  decidesWithoutBudgetHistory, 40_000);

async function refusesIntentDuringApprovalChecks() {
  const setup = await approvalFixture();
  try {
    expect((await setup.call()).status).toBe(403);
    let intended = false;
    async function intendAfterPermission() {
      await setup.append('computer-assistant', 'takeover.requested', {
        assistantId: 'assistant', computerId: 'computer', generation: 1,
        podUid: 'fixture', conversationId: 'conversation', requesterId: 'alice',
        requesterEventId: 'turn', takeoverId: 'control', leaseId: 'control',
        reason: 'requester_requested', affectedTurnIds: ['turn'],
      });
      intended = true;
    }
    const proxy = await permissionResponseProxy(setup, intendAfterPermission, 'use');
    try {
      expect((await setup.decide()).statusCode).toBe(503);
      expect(intended).toBe(true);
      expect((await setup.read()).cards[0]?.state).toBe('requested');
      expect(setup.received()).toBe(0);
      const rows = await history(setup.nats.store, 'approval-' +
        (await setup.read()).cards[0]!.approvalId, 'test');
      function isDecision(row: typeof rows[number]) {
        return row.event.type === 'approval.decided';
      }
      expect(rows.some(isDecision)).toBe(false);
    } finally {
      await proxy.close();
    }
  } finally {
    await setup.close();
  }
}
it('refuses intent saved during approval permission checks before saving a decision',
  refusesIntentDuringApprovalChecks, 40_000);

it('returns the same refusal for missing and inaccessible approvals to one authorised caller',
  async function hidesApprovalExistence() {
    const setup = await approvalFixture();
    try {
      await setup.call();
      const session = setup.headers();
      const { cards, csrf } = await setup.read(session);
      expect(cards).toHaveLength(1);
      const current = await readApproval(setup.nats.store, 'test', cards[0]!.approvalId);
      const requesterApprovalId = 'b'.repeat(64);
      const conversationApprovalId = 'c'.repeat(64);
      const foreignRequester = { ...current.request, approvalId: requesterApprovalId,
        requesterId: 'bob' };
      const foreignConversation = { ...current.request, approvalId: conversationApprovalId,
        conversationId: 'other-conversation' };
      await setup.append('approval-' + requesterApprovalId, 'tool.approval_requested',
        foreignRequester);
      await setup.append('approval-' + conversationApprovalId, 'tool.approval_requested',
        foreignConversation);
      const siloApprovalId = 'd'.repeat(64);
      const foreignSilo = envelope('foreign', `approval-${siloApprovalId}`,
        'tool.approval_requested', { ...current.request, approvalId: siloApprovalId });
      await setup.stopDispatch();
      await setup.runtime.stop();
      await setup.nats.seed([foreignSilo]);
      const approvalIds = [requesterApprovalId, conversationApprovalId,
        siloApprovalId, 'a'.repeat(64)];
      for (const approvalId of approvalIds) {
        const request = { method: 'POST' as const,
          url: '/api/conversations/conversation/approvals',
          headers: { ...session, 'x-csrf-token': csrf },
          payload: { approvalId, decision: 'rejected' } };
        const response = await setup.app.inject(request);
        expect(response.statusCode, approvalId).toBe(403);
        expect(response.json(), approvalId).toEqual({ status: 'refused' });
      }
    } finally {
      await setup.close();
    }
  });

const datedApprovalEnds = [
  ['approval.decided', { decision: 'approved', decidedBy: 'alice' }, 'approved',
    { decidedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.decided', { decision: 'rejected', decidedBy: 'alice' }, 'denied',
    { decidedAt: '2026-10-12T10:01:00.000Z', endedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.expired', {}, 'expired', { endedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.cancelled', {}, 'cancelled', { endedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.used', { permitId: 'dated-permit' }, 'outcome_unknown',
    { usedAt: '2026-10-12T10:01:00.000Z',
      uses: [{ permitId: 'dated-permit', usedAt: '2026-10-12T10:01:00.000Z' }] }],
] as const;

async function preservesApprovalDates(type: string, details: object, state: string,
  dates: object) {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const initial = (await setup.read()).cards[0]!;
    expect(initial).not.toHaveProperty('decidedAt');
    expect(initial).not.toHaveProperty('usedAt');
    expect(initial).not.toHaveProperty('endedAt');
    const approvalId = initial.approvalId;
    const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    const saved = { ...rows[0]!.event, id: 'dated-approval-end', commandId: 'dated-end',
      time: '2026-10-12T10:01:00.000Z', type, data: { approvalId, ...details } };
    await setup.nats.seed([saved]);
    const before = (await setup.read()).cards[0]!;
    expect(before).toMatchObject({ state, requestedAt: rows[0]!.event.time, ...dates });
    expect(before).not.toHaveProperty('cancelReason');
    await setup.restart();
    await setup.runner.rebuild(auditTrail);
    await setup.restartReader();
    expect((await setup.read()).cards[0]).toEqual(before);
    const later = new Date(Date.now() + 60_000);
    const delayed = await readApproval(setup.nats.store, 'test', approvalId, { now: later });
    expect(delayed).toMatchObject({ state, requestedAt: rows[0]!.event.time, ...dates });
  } finally {
    await setup.close();
  }
}
it.each(datedApprovalEnds)('keeps saved UTC dates for %s / %s after restart and replay',
  preservesApprovalDates, 40_000);

async function replaysOffsetApprovalDates(type: string, details: object, state: string,
  dates: object) {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const original = (await setup.read()).cards[0]!;
    const current = await readApproval(setup.nats.store, 'test', original.approvalId);
    const approvalId = 'f'.repeat(64);
    const subject = `approval-${approvalId}`;
    const request = { ...current.request, approvalId };
    const requested = { ...envelope('test', subject, 'tool.approval_requested', request),
      time: '2026-10-12T12:00:00+02:00' };
    const ended = { ...envelope('test', subject, type, { approvalId, ...details }),
      time: '2026-10-12T12:01:00+02:00' };
    expect(parseEventByType(requested).success).toBe(true);
    expect(parseEventByType(ended).success).toBe(true);
    await setup.nats.seed([requested, ended]);
    await setup.restart();
    await setup.runner.rebuild(auditTrail);
    await setup.restartReader();
    const replayed = await readApproval(setup.nats.store, 'test', approvalId);
    const expected = { state, requestedAt: '2026-10-12T10:00:00.000Z', ...dates };
    expect(replayed).toMatchObject(expected);
    const response = await setup.read();
    function isOffsetApproval(card: (typeof response.cards)[number]) {
      return card.approvalId === approvalId;
    }
    expect(response.cards.find(isOffsetApproval)).toMatchObject(expected);
  } finally {
    await setup.close();
  }
}
it.each(datedApprovalEnds)('replays offset dates as UTC for %s / %s in cards replies',
  replaysOffsetApprovalDates, 40_000);

async function keepsMicrosecondsInOffsetApprovalDates() {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const original = (await setup.read()).cards[0]!;
    const current = await readApproval(setup.nats.store, 'test', original.approvalId);
    const approvalId = 'e'.repeat(64);
    const subject = `approval-${approvalId}`;
    const request = { ...current.request, approvalId };
    const requested = { ...envelope('test', subject, 'tool.approval_requested', request),
      time: '2026-10-12T12:00:00.123456+02:00' };
    const decided = { ...envelope('test', subject, 'approval.decided',
      { approvalId, decision: 'approved', decidedBy: 'alice' }),
      time: '2026-10-12T12:01:00.123456+02:00' };
    const used = { ...envelope('test', subject, 'approval.used',
      { approvalId, permitId: 'microsecond-permit' }),
      time: '2026-10-12T12:02:00.123456+02:00' };
    const ended = { ...envelope('test', subject, 'approval.expired', { approvalId }),
      time: '2026-10-12T12:03:00.123456+02:00' };
    await setup.nats.seed([requested, decided, used, ended]);
    await setup.restart();
    await setup.runner.rebuild(auditTrail);
    await setup.restartReader();

    const response = await setup.read();
    function isOffsetApproval(card: (typeof response.cards)[number]) {
      return card.approvalId === approvalId;
    }
    expect(response.cards.find(isOffsetApproval)).toMatchObject({
      requestedAt: '2026-10-12T10:00:00.123456Z',
      decidedAt: '2026-10-12T10:01:00.123456Z',
      usedAt: '2026-10-12T10:02:00.123456Z',
      endedAt: '2026-10-12T10:03:00.123456Z',
      uses: [{ permitId: 'microsecond-permit', usedAt: '2026-10-12T10:02:00.123456Z' }],
    });
  } finally {
    await setup.close();
  }
}
it('keeps six fractional digits when offset approval dates reach parsed cards replies',
  keepsMicrosecondsInOffsetApprovalDates, 40_000);

const recordedCancellations = [
  ['conversation.closed', { conversationId: 'conversation', closedBy: 'alice' },
    'conversation-conversation', 'conversation_closed'],
  ['message.posted', { conversationId: 'conversation', authorId: 'alice',
    authorKind: 'human', contentType: 'text' },
    'conversation-conversation', 'new_message'],
  ['mcp.server_unpublished', { serverId: 'fixture', unpublishedBy: 'alice' },
    'mcp-fixture', 'unpublished'],
] as const;

async function recordsCancellationCause(type: string, data: object, subject: string,
  cancelReason: string) {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const approvalId = (await setup.read()).cards[0]!.approvalId;
    let payload = data;
    if (type === 'message.posted') {
      const encrypted = setup.keys.encrypt('test', 'conversation', 'New request');
      payload = { ...data, ...encrypted };
    }
    await setup.append(subject, type, payload);
    const current = await readApproval(setup.nats.store, 'test', approvalId);
    expect(current).toMatchObject({ state: 'cancelled', cancelReason });
    const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    const end = rows.at(-1)!.event;
    expect(end.data).toEqual({ approvalId, cancelReason });
    expect(current).toHaveProperty('endedAt', end.time);
    await setup.restart();
    await setup.runner.rebuild(auditTrail);
    expect(await readApproval(setup.nats.store, 'test', approvalId)).toEqual(current);
    for (const raw of ['secret-token', 'hello', 'order=42', '{"result":"done"}']) {
      const unsafe = { ...end, data: { approvalId, cancelReason: raw } };
      expect(parseEventByType(unsafe).success).toBe(false);
    }
  } finally {
    await setup.close();
  }
}
it.each(recordedCancellations)('records only the saved cancellation cause for %s',
  recordsCancellationCause, 40_000);

async function changedConnection() {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const before = await readToolPolicy(setup.nats.store, 'test', 'fixture');
    const data = { ...before.catalogue!, connectionId: 'replacement-connection' };
    await setup.append('mcp-fixture', 'mcp.server_discovered', data);
    const card = (await setup.read()).cards[0]!;
    expect(card).toMatchObject({ state: 'cancelled', cancelReason: 'connection_changed' });
    const rows = await history(setup.nats.store, `approval-${card.approvalId}`, 'test');
    expect(rows.at(-1)!.event.data).toEqual({ approvalId: card.approvalId,
      cancelReason: 'connection_changed' });
  } finally {
    await setup.close();
  }
}
it('records a changed connection without exposing its value', changedConnection);

async function omitsUnprovedCause() {
  const setup = await approvalFixture();
  try {
    await setup.call();
    const first = (await setup.read()).cards[0]!;
    const current = await readApproval(setup.nats.store, 'test', first.approvalId);
    const approvalId = 'e'.repeat(64);
    const request = { ...current.request, approvalId, turnId: 'missing-turn' };
    await setup.append(`approval-${approvalId}`, 'tool.approval_requested', request);
    const cancelled = await readApproval(setup.nats.store, 'test', approvalId);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled).not.toHaveProperty('cancelReason');
    const rows = await history(setup.nats.store, `approval-${approvalId}`, 'test');
    expect(rows.at(-1)!.event.data).toEqual({ approvalId });
  } finally {
    await setup.close();
  }
}
it('omits a cancellation cause when no saved event proves it', omitsUnprovedCause);
