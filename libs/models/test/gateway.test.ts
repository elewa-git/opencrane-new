import { existsSync } from 'node:fs';
import { z } from 'zod';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { computerCredentials, tokenIssuer } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { createStore, rebuildMembers, memberAuthorisation, grantStream } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { HandlerRuntime, dispatch, provisionDispatcher } from '@opencrane/handlers';
import { conversations, readConversation, pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { modelGrantHandler, BudgetActor, budgets, costCents, envelope, history, ingestUsage, models, readBudget, settlementHandler, startDecision, startGateway, totals } from '../src/index.ts';

let fga: Awaited<ReturnType<typeof openfga>>;
beforeAll(async () => { fga = await openfga(); }, 120_000);
afterAll(async () => { await fga.close(); });
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function waitForModelGrants(auth: ReturnType<typeof memberAuthorisation>, memberId: string, assistantId: string) {
  await until(async () => (await Promise.all(models.filter(m => !m.retired).flatMap(model => [
    auth.use('person', memberId, 'model', model.id), auth.use('assistant', assistantId, 'model', model.id),
  ]))).every(result => result.allowed));
}
async function fixture(daily = 2000, monthly = 20000, real = false, allowedModel = 'gpt-6-luna', team = false, grants: 'manual' | 'reactions' | 'legacy' = 'manual') {
  const directory = await mkdtemp(`${tmpdir()}/oc-models-`);
  const dbs = await databases(), nats = await natsFixture();
  const db = pgDb(dbs.queue), logger = createLogger('models-test', { level: 'silent' });
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const append = async (subject: string, type: string, payload: unknown) => {
    const event = { ...envelope('test', subject, type, payload), source: 'opencrane-server' };
    const rows = await history(nats.store, subject, 'test');
    expect((await nats.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 })).status).toBe('appended');
    if (['assistant.created', 'conversation.created', 'team.created', 'team.member_added'].includes(type)) await auth.handler.handle(event, db);
    return event;
  };
  const joined = await append('member-alice', 'member.joined', { memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'owner' });
  await db.transaction(tx => auth.handler.handle(joined, tx));
  if (team) {
    await append('team-sales', 'team.created', { teamId: 'sales', name: 'Sales', createdBy: 'alice' });
    await append('team-sales', 'team.member_added', { teamId: 'sales', memberId: 'alice', addedBy: 'alice' });
  }
  await append('assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: team ? 'sales' : 'alice', kind: team ? 'team' : 'personal' });
  await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'computer', tokenId: 'token:initial', generation: 1 });
  await append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'computer', generation: 1, podUid: 'pod' });
  await append('conversation-conversation', 'conversation.created', { conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' });
  await append('conversation-conversation', 'agent.turn_started', { conversationId: 'conversation', assistantId: 'assistant', turnId: 'turn' });
  await append('computer-assistant', 'computer.turn_started', { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation', turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn', payingGroupId: team ? 'sales' : 'personal-default' });
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...await exportJWK(publicKey), kid: 'lifecycle' };
  const issuer = 'https://lifecycle.test/';
  const privateKeyPath = `${directory}/issuer.pem`;
  await writeFile(privateKeyPath, await exportPKCS8(privateKey), { mode: 0o600 });
  let credentialClock = Math.floor(Date.now() / 1000);
  const tokens = await tokenIssuer({ privateKeyPath, issuer, now: () => credentialClock });
  const credentials = computerCredentials(nats.store, tokens, 'test');
  const sign = (claims: Record<string, unknown>, audience: string, ttl = 120) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'lifecycle' }).setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ttl).sign(privateKey);
  const c = { typ: 'computer', silo: 'test', computer: 'computer', assistant: 'assistant', generation: 1, jti: 'token:initial' };
  const t = { jti: 'token:turn', typ: 'turn', silo: 'test', assistant: 'assistant', conversation: 'conversation', turn: 'turn', thread: 'thread', task: 'chat_turn', model: allowedModel, requester: 'alice', computerTokenId: 'token:initial', delegation: ['alice'] };
  const issue = async (generation = 1, tokenId = 'token:initial', computerId = 'computer') => ({
    authorization: `Bearer ${(await tokens.computer({ silo: 'test', assistantId: 'assistant', computerId, generation, tokenId })).value}`,
    'x-turn-token': (await credentials.turn({ assistantId: 'assistant', conversationId: 'conversation', turnId: 'turn', requesterId: 'alice', threadId: 'thread', task: 'chat_turn', model: allowedModel })).value,
    'session-id': 'thread', 'content-type': 'application/json',
  });
  const headers = await issue();
  if (grants === 'manual') for (const model of models.filter(m => !m.retired)) for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const event = await append(grantStream('model', model.id), 'grant.given', { resourceType: 'model', resourceId: model.id, granteeId, granteeKind, grantedBy: 'alice' });
    await auth.handler.handle(event, db);
  }
  let clock = Date.now();
  const actor = new BudgetActor(nats.store, 'test', () => new Date(clock)); await actor.start(daily, monthly, 'personal-default');
  const decision = await startDecision(actor, { jwks: { keys: [jwk] }, issuer }, binding);
  let usage = { input_tokens: 1000, output_tokens: 120, total_tokens: 1120, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  const admitted: string[] = [];
  let received = 0, hold = false, rejection = 0, providerHeaders: string[] = [], providerAuthHash = '';
  // S0.1c's scripted Responses stream, reduced to the final usage-bearing event.
  const stub = createServer((req, res) => {
    const requestId = String(req.headers['x-request-id']);
    void history(nats.store, `decision-${requestId}`, 'test').then(rows => {
      if (rows.some(r => r.event.type === 'decision.recorded' && z.object({ outcome: z.literal('allow') }).safeParse(r.event.data).success)) admitted.push(requestId);
    });
    received++; providerHeaders = Object.keys(req.headers);
    providerAuthHash = createHash('sha256').update(req.headers.authorization ?? '').digest('hex');
    req.resume();
    if (req.url?.startsWith('/mcp/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}'); return; }
    if (rejection === -1) { req.socket.destroy(); return; }
    if (rejection) {
      res.writeHead(rejection, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Scripted provider rejection","type":"invalid_request_error"}}'); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stub","object":"response","status":"in_progress"}}\n\n');
    if (hold) return;
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_stub', object: 'response', status: 'completed', model: 'gpt-6-luna',
      output: [], usage } })}\n\n`);
  });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  const address = stub.address(); if (!address || typeof address === 'string') throw new Error('No stub');
  const keyFile = real ? resolve(process.env['MODELS_REAL_KEY_FILE'] ?? '.keys/.openai-key') : `${directory}/stub-key`;
  if (!real) await writeFile(keyFile, 'stub-only-placeholder');
  const options = { binary: resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64'),
    configFile: `${directory}/gateway.json`, usageFile: `${directory}/usage.jsonl`, keyFile,
    port: await freePort(), readinessPort: await freePort(), decisionUrl: decision.url, issuer,
    mcpRoutes: [{ serverId: 'fixture', connectionId: 'installed', upstream: `127.0.0.1:${address.port}` }],
    ...(real ? {} : { upstream: `127.0.0.1:${address.port}` }) };
  let gateway = await startGateway(options);
  const runner = new ProjectionRunner(db, nats.store, logger); await runner.initialise(budgets);
  await provisionDispatcher(nats.connection);
  const runtime = new HandlerRuntime({ db, logger, silo: 'test', handlers: [settlementHandler(decision.url), ...(grants === 'reactions' ? [modelGrantHandler(nats.store), auth.handler] : [])], retryDelay: 1 });
  await runtime.start(); await runtime.work();
  const abort = new AbortController(); const dispatching = dispatch(nats.connection, runtime, abort.signal);
  void dispatching.catch(() => undefined);
  if (grants === 'reactions') await waitForModelGrants(auth, 'alice', 'assistant');
  const body = { model: allowedModel, input: 'Say OK.', max_output_tokens: 128, stream: true, store: false, reasoning: { effort: 'minimal' } };
  return { actor, append, headers, t, c, sign, issue, credentials, binding, identity: { jwks: { keys: [jwk] }, issuer },
    credentialTime: (offset: number) => { credentialClock += offset; }, options, runner, db, nats, runtime, auth,
    decisionDown: () => decision.close(), providerAuthHash: () => providerAuthHash,
    usage: (input: number, cached: number, output: number, writes = 0) => { usage = { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: cached, cache_write_tokens: writes } }; },
    reject: (status: number) => { rejection = status; },
    admitted, received: () => received, providerHeaders: () => providerHeaders, hold: () => { hold = true; }, advance: (ms = 181_000) => { clock += ms; },
    async call(extra = {}, patch: Record<string, unknown> = {}) {
      const response = await fetch(`http://127.0.0.1:${options.port}/v1/responses`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ ...body, ...patch }) });
      return { status: response.status, text: await response.text() };
    },
    async settled() {
      await until(async () => { await ingestUsage(actor, options.usageFile); return actor.state.reservations.every(r => r.settledCents !== undefined); });
      await runner.run(budgets);
    },
    async slowDecisions() {
      await gateway.stop();
      // Keep the real gateway, but let the decision's own freshness fence end this request.
      const config = (await readFile(options.configFile, 'utf8')).replaceAll('"extAuthz":{',
        '"extAuthz":{"policies":{"http":{"requestTimeout":"10s"}},');
      await writeFile(options.configFile, config);
      const child = spawn(options.binary, ['-f', options.configFile], { stdio: 'ignore' });
      const exited = once(child, 'exit');
      gateway = { healthy: () => child.exitCode === null, stop: async () => { child.kill(); await exited; } };
      await until(async () => {
        try { return (await fetch(`http://127.0.0.1:${options.readinessPort}/healthz/ready`)).ok; }
        catch { return false; }
      });
    },
    async restart() { await gateway.stop('SIGKILL'); gateway = await startGateway(options); },
    async close() {
      await gateway.stop(); await decision.close(); stub.closeAllConnections(); await new Promise<void>(resolve => stub.close(() => resolve()));
      abort.abort(); await dispatching.catch(error => { if (!(error instanceof Error && error.name === 'AbortError')) throw error; });
      await runtime.stop(); await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}
it('fresh installation grants Phase 2 chat through reactions', async () => {
  const f = await fixture(20000, 20000, false, 'gpt-6.1-sol', false, 'reactions');
  try {
    expect((await f.call()).status).toBe(200);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it('a new member and assistant receive Phase 2 chat grants after installation', async () => {
  const f = await fixture(20000, 20000, false, 'gpt-6.1-sol', false, 'reactions');
  try {
    await f.append('member-bob', 'member.joined', { memberId: 'bob', email: 'bob@example.test', displayName: 'Bob', role: 'member' });
    await f.append('assistant-bob-assistant', 'assistant.created', { assistantId: 'bob-assistant', ownerId: 'bob', kind: 'personal' });
    await f.append('computer-bob-assistant', 'computer.claimed', { assistantId: 'bob-assistant', computerId: 'bob', tokenId: 'token:bob', generation: 1 });
    await f.append('computer-bob-assistant', 'computer.ready', { assistantId: 'bob-assistant', computerId: 'bob', generation: 1, podUid: 'bob' });
    await f.append('conversation-bob', 'conversation.created', { conversationId: 'bob', assistantId: 'bob-assistant', createdBy: 'bob', mode: 'agent_session' });
    await f.append('computer-bob-assistant', 'computer.turn_started', { assistantId: 'bob-assistant', computerId: 'bob', conversationId: 'bob', turnId: 'bob', threadId: 'bob', requesterId: 'bob', task: 'chat_turn', payingGroupId: 'personal-default' });
    await waitForModelGrants(f.auth, 'bob', 'bob-assistant');
    const headers = {
      authorization: `Bearer ${await f.sign({ ...f.c, computer: 'bob', assistant: 'bob-assistant', jti: 'token:bob' }, 'agentgateway')}`,
      'x-turn-token': (await f.credentials.turn({ assistantId: 'bob-assistant', conversationId: 'bob', turnId: 'bob', requesterId: 'bob', threadId: 'bob', task: 'chat_turn', model: 'gpt-6.1-sol' })).value,
      'session-id': 'bob',
    };
    expect((await f.call(headers)).status).toBe(200);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it('upgrade then OpenFGA replay restores Phase 2 chat without duplicate grants', async () => {
  const f = await fixture(20000, 20000, false, 'gpt-6.1-sol', false, 'legacy');
  try {
    expect((await f.call()).status).toBe(403);
    await f.append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
      resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', revokedBy: 'alice',
    });
    const migrate = () => promisify(execFile)('npm', ['run', 'migrate:model-grants', '-w', 'apps/ops'], {
      env: { ...process.env, ...f.nats.env('command'), SILO_ID: 'test' }, timeout: 10_000,
    });
    await migrate();
    const head = await f.nats.store.head();
    await migrate();
    expect(await f.nats.store.head()).toBe(head);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', f.nats.store);
    Object.assign(f.binding, rebuilt.binding);
    expect((await f.call({ 'x-turn-token': await f.sign({ ...f.t, model: 'gpt-6-luna' }, 'decision-service') },
      { model: 'gpt-6-luna' })).status).toBe(403);
    expect((await f.call()).status).toBe(200);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it.each([
  { name: 'revocation after a delayed history read exceeds two seconds', pauseMs: 2100, revoke: true },
  { name: 'revocation during a history read within the freshness budget', pauseMs: 10, revoke: true },
  { name: 'a history read exceeds the freshness budget without a revocation', pauseMs: 2100, revoke: false },
])('does not dispatch a running decision: $name', async ({ pauseMs, revoke }) => {
  const f = await fixture();
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    await f.slowDecisions();
    let captured!: () => void, resume!: () => void;
    const capturing = new Promise<void>(resolve => { captured = resolve; });
    const resuming = new Promise<void>(resolve => { resume = resolve; });
    const readStream = f.nats.store.readStream.bind(f.nats.store);
    const slowHistory = vi.spyOn(f.nats.store, 'readStream').mockImplementation(async function* (...args) {
      if (args[0] === 'member-alice') {
        captured();
        await resuming;
        await delay(pauseMs);
      }
      yield* readStream(...args);
    });
    try {
      const pending = f.call();
      await capturing;
      if (revoke) await f.append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
        resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', revokedBy: 'alice',
      });
      const revoked = performance.now();
      resume();
      const response = await pending;
      if (pauseMs > 2000) expect(performance.now() - revoked).toBeGreaterThan(2000);
      expect(f.received()).toBe(1);
      expect(response.status).toBe(403);
      expect(f.actor.state.reservations).toHaveLength(1);
    } finally { resume(); slowHistory.mockRestore(); }
  } finally { await f.close(); }
}, 40_000);

it('releases undispatched reservations when authority is revoked after the allow audit', async () => {
  const f = await fixture(50, 50);
  let replacement: Awaited<ReturnType<typeof startDecision>> | undefined;
  const append = f.nats.store.append.bind(f.nats.store);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const race = vi.spyOn(f.nats.store, 'append').mockImplementation(async command => {
        const result = await append(command);
        if (typeof command.event === 'object' && command.event !== null && 'type' in command.event &&
            command.event.type === 'decision.recorded' && 'data' in command.event &&
            z.object({ outcome: z.literal('allow') }).safeParse(command.event.data).success) {
          const revoked = await f.append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
            resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', revokedBy: 'alice',
          });
          await f.auth.handler.handle(revoked, f.db);
        }
        return result;
      });
      try { expect((await f.call()).status).toBe(503); }
      finally { race.mockRestore(); }
      const restored = await f.append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
        resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'alice', granteeKind: 'member', grantedBy: 'alice',
      });
      await f.auth.handler.handle(restored, f.db);
    }
    expect(f.received()).toBe(0);
    const settlements = (await history(f.nats.store, 'budget-test', 'test')).filter(r => r.event.type === 'budget.settled');
    expect(settlements.map(r => r.event.data)).toEqual(f.actor.state.reservations.map(r => ({
      reservationId: r.id, permitId: r.id, settledCents: 0, outcome: 'not_dispatched',
    })));
    f.advance(); await f.actor.expire();
    expect.soft(totals(f.actor.state)).toMatchObject({ reservedCents: 0, todayCents: 0, monthCents: 0 });
    for (const r of f.actor.state.reservations) {
      expect.soft(await history(f.nats.store, `effect-${r.id}`, 'test')).toEqual([]);
    }
    await f.decisionDown();
    const recovered = new BudgetActor(f.nats.store, 'test', f.actor.now); await recovered.start();
    replacement = await startDecision(recovered, f.identity, f.binding, Number(new URL(f.options.decisionUrl).port));
    await recovered.expire();
    expect.soft(totals(recovered.state)).toEqual({ reservedCents: 0, todayCents: 0, monthCents: 0,
      dailyCeilingCents: 50, ceilingCents: 50 });
    expect((await f.call()).status).toBe(200);
    await until(async () => {
      await ingestUsage(recovered, f.options.usageFile);
      return recovered.state.reservations.every(r => r.settledCents !== undefined);
    });
    expect(f.received()).toBe(1);
    expect(totals(recovered.state)).toMatchObject({ reservedCents: 0, todayCents: 1, monthCents: 1,
      dailyCeilingCents: 50, ceilingCents: 50 });
    await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(recovered.state);
  } finally { await replacement?.close(); await f.close(); }
}, 40_000);

it('refuses gpt-5.5 for a chat turn before reserving or reaching the provider', async () => {
  const f = await fixture(20000, 20000, false, 'gpt-6.1-sol');
  try {
    expect((await f.call({}, { model: 'gpt-5.5' })).status).toBe(403);
    expect(f.actor.state.reservations).toHaveLength(0);
    expect((await history(f.nats.store, 'budget-test', 'test')).map(r => r.event.type))
      .toEqual(['budget.ceiling_set', 'budget.period_started']);
    expect(f.received()).toBe(0);
    expect((await f.credentials.check(f.headers)).turn).toMatchObject({ task: 'chat_turn', model: 'gpt-6.1-sol' });
    expect((await f.call()).status).toBe(200); await f.settled();
  } finally { await f.close(); }
}, 40_000);
it('settles streamed gateway usage exactly, strips identity, rebuilds PostgreSQL, and rejects invalid calls before the provider', async () => {
  const f = await fixture();
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    expect(f.actor.state.reservations[0]?.settledCents).toBe(costCents('gpt-6-luna', 1000, 120));
    expect(totals(await readBudget(f.db, 'test')).reservedCents).toBe(0);
    const before = await readBudget(f.db, 'test'); await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(before);
    expect(f.providerAuthHash()).toBe(createHash('sha256').update('Bearer stub-only-placeholder').digest('hex'));
    expect(f.providerHeaders()).not.toContain('x-turn-token'); expect(f.providerHeaders()).not.toContain('session-id');
    for (const bad of [{ 'session-id': 'other' }, { 'x-turn-token': 'forged' }, { authorization: 'Bearer forged' },
      { 'x-turn-token': await f.sign(f.t, 'decision-service', -1) }, { authorization: `Bearer ${await f.sign(f.c, 'agentgateway', -1)}` },
      { 'x-turn-token': await f.sign({ ...f.t, silo: 'other' }, 'decision-service') }]) expect((await f.call(bad)).status).toBeGreaterThanOrEqual(400);
    for (const patch of [{ model: 'other' }, { model: 'gpt-5-nano' }, { model: 'gpt-5-mini' }, { max_output_tokens: 0 }, { max_output_tokens: 15 }, { max_output_tokens: 2001 }, { max_output_tokens: null },
      { previous_response_id: 'old' }, { tools: [{ type: 'web_search' }] }, { service_tier: 'priority' }, { n: 2 },
      { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/a' }] }] }]) {
      expect((await f.call({}, patch)).status).toBe(403);
    }
    expect(f.received()).toBe(1);
    const duplicate = await fetch(`http://127.0.0.1:${f.options.port}/v1/responses`, { method: 'POST', headers: f.headers,
      body: '{"model":"gpt-6.1-sol","model":"gpt-6-luna","input":"OK","max_output_tokens":128,"stream":true}' });
    expect(duplicate.status).toBe(403); expect(f.received()).toBe(1);
    await fga.pause();
    try { expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1); } finally { await fga.resume(); }
    const removed = await f.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
    await f.db.transaction(tx => f.auth.handler.handle(removed, tx));
    expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1);
    await f.decisionDown(); expect((await f.call()).status).toBe(503); expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);
it('uses lifecycle credentials and refuses expired, pre-resume and pre-loss grants before reserving', async () => {
  const f = await fixture();
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    const budgetBefore = await history(f.nats.store, 'budget-test', 'test');
    const refused = async (headers = f.headers) => {
      expect((await f.call(headers)).status).toBeGreaterThanOrEqual(400);
      expect(await history(f.nats.store, 'budget-test', 'test')).toEqual(budgetBefore);
      expect(f.received()).toBe(1);
    };
    f.credentialTime(-601);
    await refused(await f.issue());
    f.credentialTime(480); // Unexpired computer, expired turn.
    await refused(await f.issue());
    f.credentialTime(121);
    await f.append('computer-assistant', 'computer.suspended', { assistantId: 'assistant', computerId: 'computer' });
    await refused();
    await f.append('computer-assistant', 'computer.resumed', { assistantId: 'assistant', computerId: 'computer', generation: 1, tokenId: 'token:resumed' });
    await refused();
    await f.append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'computer', generation: 1, podUid: 'resumed' });
    const resumed = await f.issue(1, 'token:resumed');
    await refused({ ...resumed, authorization: f.headers.authorization });
    await refused({ ...resumed, 'x-turn-token': f.headers['x-turn-token'] });
    await f.append('computer-assistant', 'computer.lost', { assistantId: 'assistant', computerId: 'computer' });
    await refused(resumed);
    await f.append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'computer', generation: 2, tokenId: 'token:replacement' });
    await refused(resumed);
    await f.append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'computer', generation: 2, podUid: 'replacement' });
    const replacement = await f.issue(2, 'token:replacement');
    await refused({ ...replacement, authorization: resumed.authorization });
    await refused({ ...replacement, 'x-turn-token': resumed['x-turn-token'] });
    await refused(await f.issue(1, 'token:replacement'));
    await refused(await f.issue(2, 'token:replacement', 'other-computer'));
    expect((await f.call(replacement)).status).toBe(200);
    expect(f.received()).toBe(2);
  } finally { await f.close(); }
}, 40_000);
it('accepts a re-observed Ready computer after a legacy resume without generation', async () => {
  const f = await fixture();
  try {
    await f.append('computer-assistant', 'computer.suspended', { assistantId: 'assistant', computerId: 'computer' });
    await f.append('computer-assistant', 'computer.resumed', { assistantId: 'assistant', computerId: 'computer', tokenId: 'token:legacy-resume' });
    await f.append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'computer', generation: 1, podUid: 'observed' });
    const current = await f.issue(1, 'token:legacy-resume');
    expect((await f.call(current)).status).toBe(200);
    expect((await f.call()).status).toBe(403);
    expect(f.actor.state.reservations).toHaveLength(1);
  } finally { await f.close(); }
}, 40_000);
it.each([{ computerId: 'old-computer', generation: 2 }, { computerId: 'computer', generation: 1 }, { computerId: 'computer' }])(
  'refuses readiness that does not match the current claim: %j', async ready => {
  const f = await fixture();
  try {
    await f.append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'computer', generation: 2, tokenId: 'token:replacement' });
    await f.append('computer-assistant', 'computer.ready', { assistantId: 'assistant', ...ready });
    const headers = { authorization: `Bearer ${await f.sign({ ...f.c, generation: 2, jti: 'token:replacement' }, 'agentgateway')}`,
      'x-turn-token': await f.sign({ ...f.t, computerTokenId: 'token:replacement' }, 'decision-service') };
    expect((await f.call(headers)).status).toBe(403);
    expect((await history(f.nats.store, 'budget-test', 'test')).map(r => r.event.type)).toEqual(['budget.ceiling_set', 'budget.period_started']);
    expect(f.received()).toBe(0);
  } finally { await f.close(); }
}, 40_000);
it.each([[25, 2000], [2000, 25]])('admits one last reservation under daily %i / monthly %i cents and clearly refuses the next call', async (daily, monthly) => {
  const f = await fixture(daily, monthly);
  try {
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.call()));
    expect(replies.filter(r => r.status === 200)).toHaveLength(1); expect(f.received()).toBe(1);
    expect(replies.filter(r => r.status === 402)).toHaveLength(7); await f.settled();
    expect((await f.call()).text).toContain('spending cap reached');
    await f.runner.initialise(conversations); await f.runner.run(conversations);
    const feed = await readConversation(f.db, 'test', 'conversation');
    expect(feed.rows.filter(row => row.type === 'decision.recorded')).toHaveLength(8);
    for (const row of feed.rows.filter(row => row.type === 'decision.recorded')) expect(row.data).toEqual({ turnId: 'turn', reason: 'budget_exhausted' });
    await f.runner.rebuild(conversations);
    expect((await readConversation(f.db, 'test', 'conversation')).rows).toEqual(feed.rows);
  } finally { await f.close(); }
}, 40_000);
it('retains an in-flight reservation across gateway kill and actor recovery, recording uncertainty after timeout', async () => {
  const f = await fixture(25, 200);
  try {
    f.hold(); const call = f.call().catch(() => ({ status: 502 }));
    await until(() => f.received() === 1); await f.restart(); await call;
    f.advance(); await f.actor.expire();
    const r = f.actor.state.reservations[0]!;
    expect((await history(f.nats.store, `effect-${r.id}`, 'test')).map(r => r.event.type)).toContain('effect.uncertain');
    const recovered = new BudgetActor(f.nats.store, 'test'); await recovered.start();
    expect(totals(recovered.state).reservedCents).toBe(25);
    expect((await f.call()).status).toBe(403); // The old actor cannot append after the replacement's fence.
    await f.runner.rebuild(budgets); expect(totals(await readBudget(f.db, 'test')).reservedCents).toBe(25);
  } finally { await f.close(); }
}, 40_000);
it('recovers old-tariff usage after an upgrade and continues past an unknown model', async () => {
  const f = await fixture(20000, 20000, false, 'gpt-6.1-sol');
  let replacement: Awaited<ReturnType<typeof startDecision>> | undefined;
  try {
    const pending = [
      { id: randomUUID(), model: 'gpt-5-nano', amountCents: 50, expectedCents: 43 },
      { id: randomUUID(), model: 'unknown-model', amountCents: 100, expectedCents: undefined },
      { id: randomUUID(), model: 'unknown-model', amountCents: 100, expectedCents: undefined, outcome: 'error' as const },
      { id: randomUUID(), model: 'gpt-5-mini', amountCents: 250, expectedCents: 214 },
    ];
    for (const row of pending) await f.append('budget-test', 'budget.reserved', {
      reservationId: row.id, permitId: row.id, amountCents: row.amountCents, payingGroupId: 'test', assistantId: 'assistant',
      modelCall: { model: row.model, priceTableId: 'openai-2026-10-02-eur95', computerId: 'computer', assistantId: 'assistant',
        requesterId: 'alice', conversationId: 'conversation', turnId: 'turn', threadId: 'thread', contextDigest: '0'.repeat(64) },
    });
    await writeFile(f.options.usageFile, pending.map(row => JSON.stringify('outcome' in row ? { id: row.id, outcome: row.outcome } : { id: row.id, inputTokens: 1_000_000, outputTokens: 1_000_000 })).join('\n') + '\n');
    await f.decisionDown();
    const recovered = new BudgetActor(f.nats.store, 'test'); await recovered.start();
    replacement = await startDecision(recovered, f.identity, f.binding, Number(new URL(f.options.decisionUrl).port));
    await ingestUsage(recovered, f.options.usageFile);
    await until(() => recovered.state.reservations.filter(r => r.call.model !== 'unknown-model').every(r => r.settledCents !== undefined));
    for (const row of pending) {
      expect(recovered.state.reservations.find(r => r.id === row.id)?.settledCents).toBe(row.expectedCents);
      const effects = await history(f.nats.store, `effect-${row.id}`, 'test');
      expect(effects.map(r => r.event.type)).toEqual([row.expectedCents === undefined ? 'effect.uncertain' : 'effect.observed']);
      if (row.expectedCents === undefined) expect(effects[0]?.event.data).toMatchObject({ reason: 'unknown_tariff' });
      else expect(effects[0]?.event.data).toMatchObject({ costCents: row.expectedCents, usage: { priceTableId: 'openai-2026-10-02-eur95' } });
    }
    expect(totals(recovered.state).reservedCents).toBe(200);
    for (const model of ['gpt-5-nano', 'gpt-5-mini']) {
      expect((await f.call({ 'x-turn-token': await f.sign({ ...f.t, model }, 'decision-service') }, { model })).status).toBe(403);
    }
    expect((await f.call()).status).toBe(200);
    await until(async () => {
      await ingestUsage(recovered, f.options.usageFile);
      return recovered.state.reservations.at(-1)?.settledCents !== undefined;
    });
    expect(recovered.state.reservations.at(-1)?.settledCents).toBe(1);
    expect(totals(recovered.state)).toMatchObject({ reservedCents: 200, todayCents: 258 });
    expect(f.received()).toBe(1);
    await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(recovered.state);
  } finally { await replacement?.close(); await f.close(); }
}, 40_000);
it('records exhaustion once even when decision audit appends fail and callers retry', async () => {
  const f = await fixture(0, 0);
  const append = f.nats.store.append.bind(f.nats.store);
  const fault = vi.spyOn(f.nats.store, 'append').mockImplementation(command => {
    if (typeof command.event === 'object' && command.event !== null && 'type' in command.event && command.event.type === 'decision.recorded') {
      return Promise.resolve({ status: 'unavailable', cause: new Error('Scripted decision audit outage') });
    }
    return append(command);
  });
  try {
    expect((await f.call()).status).toBe(503);
    expect((await f.call()).status).toBe(503);
    expect((await history(f.nats.store, 'budget-test', 'test')).map(r => r.event.type))
      .toEqual(['budget.ceiling_set', 'budget.period_started', 'budget.exhausted']);
    expect(await history(f.nats.store, 'security-test', 'test')).toEqual([]);
    expect(f.received()).toBe(0);
  } finally { fault.mockRestore(); await f.close(); }
}, 40_000);
it('does not duplicate exhaustion after its append succeeds but the acknowledgement is lost', async () => {
  const f = await fixture(25, 25);
  try {
    expect((await f.call()).status).toBe(200);
    const append = f.nats.store.append.bind(f.nats.store);
    const fault = vi.spyOn(f.nats.store, 'append').mockImplementation(async command => {
      const result = await append(command);
      if (typeof command.event === 'object' && command.event !== null && 'type' in command.event && command.event.type === 'budget.exhausted') {
        return { status: 'unavailable', cause: new Error('Scripted lost acknowledgement') };
      }
      return result;
    });
    try { expect((await f.call()).status).toBe(403); } finally { fault.mockRestore(); }
    expect((await f.call()).status).toBe(403); // The uncertain writer stops admitting commands.
    const recovered = new BudgetActor(f.nats.store, 'test'); await recovered.start();
    await expect(recovered.reserve(f.actor.state.reservations[0]!.call, 25)).rejects.toThrow('spending cap');
    expect((await history(f.nats.store, 'budget-test', 'test')).map(r => r.event.type))
      .toEqual(['budget.ceiling_set', 'budget.period_started', 'budget.reserved', 'budget.exhausted', 'budget.period_started']);
    expect(await history(f.nats.store, 'security-test', 'test')).toEqual([]);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);
it('leaves money reserved on settlement failure and retries the recorded effect idempotently', async () => {
  const f = await fixture();
  try {
    await f.runtime.stop(); expect((await f.call()).status).toBe(200);
    await until(async () => { await ingestUsage(f.actor, f.options.usageFile); return (await history(f.nats.store, `effect-${f.actor.state.reservations[0]!.id}`, 'test')).length > 0; });
    expect(totals(f.actor.state).reservedCents).toBe(25);
    const r = f.actor.state.reservations[0]!;
    await expect(f.actor.settleRecorded(r.id, randomUUID())).rejects.toThrow('Effect not recorded');
    const effect = (await history(f.nats.store, `effect-${r.id}`, 'test'))[0]!.event;
    const replacement = new BudgetActor(f.nats.store, 'test'); await replacement.start();
    await expect(f.actor.settle(effect)).rejects.toThrow('lost its fence');
    expect(totals(f.actor.state).reservedCents).toBe(25);
    await replacement.settle(effect); await replacement.settle(effect);
    expect(totals(replacement.state).reservedCents).toBe(0);
    expect((await history(f.nats.store, 'budget-test', 'test')).filter(r => r.event.type === 'budget.settled')).toHaveLength(1);
  } finally { await f.close(); }
}, 40_000);
it.each([400, 401, 404, 429, 500])('releases an observed provider %i rejection without usage or consuming the cap', async status => {
  const f = await fixture(25, 25);
  try {
    f.reject(status); expect((await f.call()).status).toBe(status);
    await f.settled();
    const r = f.actor.state.reservations[0]!;
    expect((await history(f.nats.store, `effect-${r.id}`, 'test')).map(r => ({ type: r.event.type, data: r.event.data })))
      .toEqual([{ type: 'effect.observed', data: { permitId: r.id, computerId: 'computer', tool: 'gpt-6-luna', destination: 'openai', costCents: 0, outcome: 'error' } }]);
    expect(totals(f.actor.state)).toMatchObject({ reservedCents: 0, todayCents: 0, monthCents: 0 });
    await f.actor.settleRecorded(r.id, `${r.id}:effect.observed`);
    expect((await history(f.nats.store, 'budget-test', 'test')).filter(r => r.event.type === 'budget.settled')).toHaveLength(1);
    f.reject(0); expect((await f.call()).status).toBe(200); await f.settled();
  } finally { await f.close(); }
}, 40_000);
it.each([408, 504, -1])('retains the reservation for an ambiguous provider outcome %i', async status => {
  const f = await fixture(25, 25);
  try {
    f.reject(status); expect((await f.call()).status).toBeGreaterThanOrEqual(400);
    await f.restart(); // Drain the gateway log writer before inspecting its observations.
    await ingestUsage(f.actor, f.options.usageFile);
    f.advance(); await f.actor.expire();
    const r = f.actor.state.reservations[0]!;
    expect((await history(f.nats.store, `effect-${r.id}`, 'test')).map(r => r.event.type)).toEqual(['effect.uncertain']);
    expect(totals(f.actor.state).reservedCents).toBe(25);
  } finally { await f.close(); }
}, 40_000);
it('rolls UTC periods without forgetting outstanding reservations', async () => {
  const f = await fixture(25, 250);
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    f.advance(32 * 86400_000);
    expect(totals(f.actor.state, f.actor.now())).toMatchObject({ todayCents: 0, monthCents: 0 });
    const call = f.actor.state.reservations[0]!.call;
    await f.actor.reserve(call, 25); f.advance(32 * 86400_000);
    expect(totals(f.actor.state, f.actor.now()).reservedCents).toBe(25);
    await expect(f.actor.reserve(call, 25)).rejects.toThrow('spending cap');
    await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(f.actor.state);
  } finally { await f.close(); }
}, 40_000);
it.runIf(process.env['MODELS_REAL_CALL'] === '1')('makes exactly three approved real OpenAI calls and records only tokens and cents', async () => {
  if (existsSync('.tools/models-real-attempts.json')) throw new Error('Paid calls already attempted; do not rerun');
  const f = await fixture(20000, 20000, true);
  const receipts: { model: string; status?: number }[] = [];
  try {
    for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']) {
      // Record before sending; an interrupted attempt must never be silently retried.
      receipts.push({ model });
      await writeFile('.tools/models-real-attempts.json', JSON.stringify(receipts, null, 2));
      const reply = await f.call({ 'x-turn-token': await f.sign({ ...f.t, model }, 'decision-service') }, { model, max_output_tokens: 16, reasoning: { effort: 'low' }, service_tier: 'default' });
      receipts.at(-1)!.status = reply.status;
      await writeFile('.tools/models-real-attempts.json', JSON.stringify(receipts, null, 2));
      expect(reply.status).toBe(200);
      const finalSchema = z.object({ type: z.enum(['response.completed', 'response.incomplete']), response: z.object({
        model: z.string(), usage: z.object({ input_tokens: z.number(), output_tokens: z.number(),
          input_tokens_details: z.object({ cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional() }).optional() }),
      }) });
      const final = reply.text.split('\n').filter(line => line.startsWith('data: {'))
        .map(line => finalSchema.safeParse(JSON.parse(line.slice(6)) as unknown)).find(result => result.success)?.data;
      if (!final) throw new Error('Provider usage missing');
      expect(final.response.model.startsWith(model)).toBe(true);
      await f.settled();
      const r = f.actor.state.reservations.at(-1)!;
      const effect = (await history(f.nats.store, `effect-${r.id}`, 'test'))[0]!.event;
      await writeFile('.tools/models-real-receipt.json', JSON.stringify(f.actor.state.reservations.map(r => ({
        model: r.call.model, costCents: r.settledCents,
      })), null, 2));
      await writeFile(`.tools/models-real-${model}.json`, JSON.stringify({ model, responseStatus: final.type, providerUsage: final.response.usage, usage: effect.data,
        costCents: r.settledCents }, null, 2));
    }
    expect(f.actor.state.reservations).toHaveLength(3);
  } finally { await f.close(); }
}, 120_000);
it('settles cached input reported by the real gateway at its discounted rate', async () => {
  const f = await fixture(10000, 20000);
  try {
    f.usage(100_000, 80_000, 1000);
    expect((await f.call({ 'x-turn-token': await f.sign({ ...f.t, model: 'gpt-6-astra' }, 'decision-service') }, { model: 'gpt-6-astra' })).status).toBe(200);
    await f.settled();
    expect(f.actor.state.reservations[0]?.settledCents).toBe(32);
    f.usage(300_000, 100_000, 1000, 100_000);
    expect((await f.call({ 'x-turn-token': await f.sign({ ...f.t, model: 'gpt-6-astra' }, 'decision-service') }, { model: 'gpt-6-astra' })).status).toBe(200);
    await f.settled();
    expect(f.actor.state.reservations[1]?.settledCents).toBe(454);
  } finally { await f.close(); }
}, 40_000);
it.each([[2494, 20000], [20000, 2494]])('caps expensive Astra before reaching OpenAI with daily %i / monthly %i', async (daily, monthly) => {
  const f = await fixture(daily, monthly);
  try {
    expect((await f.call({ 'x-turn-token': await f.sign({ ...f.t, model: 'gpt-6-astra' }, 'decision-service') }, { model: 'gpt-6-astra' })).status).toBe(402);
    expect(f.received()).toBe(0);
  } finally { await f.close(); }
}, 40_000);
it('accepts the native Codex text request shape while retaining the bounded Responses contract', async () => {
  const f = await fixture();
  try {
    expect((await f.call({}, { input: [{ type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: 'Say OK.' }] }],
      tool_choice: 'auto', parallel_tool_calls: true, reasoning: { summary: 'auto' }, include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'thread', client_metadata: { 'x-codex-turn-metadata': '{}' } })).status).toBe(200);
    await f.settled(); expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it('admits every pinned model through the decision and gateway under the same caps', async () => {
  const f = await fixture(20000, 20000);
  try {
    for (const model of models.filter(row => !row.retired)) {
      expect((await f.call({ 'x-turn-token': await f.sign({ ...f.t, model: model.id }, 'decision-service') }, { model: model.id })).status).toBe(200);
      await f.settled();
    }
    expect(f.received()).toBe(11);
  } finally { await f.close(); }
}, 40_000);

it.each(['agent.turn_completed', 'agent.turn_failed'])('a forged computer restart after %s stays refused without a reservation', async type => {
  const f = await fixture();
  try {
    await f.append('conversation-conversation', type, { conversationId: 'conversation', turnId: 'turn', ...(type.endsWith('failed') ? { reason: 'bridge_interrupted' } : {}) });
    await f.append('computer-assistant', 'computer.turn_closed', { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation', turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn', status: type.endsWith('failed') ? 'failed' : 'completed' });
    const rows = await history(f.nats.store, 'conversation-conversation', 'test');
    const event = { ...envelope('test', 'conversation-conversation', 'agent.turn_started', { conversationId: 'conversation', turnId: 'turn', assistantId: 'assistant' }), source: 'computer-bridge' };
    expect((await f.nats.store.append({ event, expectedSequence: rows.at(-1)!.sequence })).status).toBe('appended');
    expect((await f.call()).status).toBe(403);
    expect(f.actor.state.reservations).toHaveLength(0);
    expect(f.received()).toBe(0);
  } finally { await f.close(); }
}, 40_000);

it('refuses a valid signed grant installed under another actual Codex thread before reserving', async () => {
  const f = await fixture();
  try {
    const token = await f.sign({ ...f.t, thread: 'thread', task: 'chat_turn' }, 'decision-service');
    expect((await f.call({ 'x-turn-token': token, 'session-id': 'conversation' })).status).toBe(403);
    expect(f.actor.state.reservations).toHaveLength(0);
    expect((await f.call({ 'x-turn-token': token, 'session-id': 'thread' })).status).toBe(200);
    await f.settled();
  } finally { await f.close(); }
}, 40_000);

// Captured from the pinned computer's native gpt-6.1-sol text turn.
it('admits routed Sol tool declarations and settings while refusing malformed or unknown fields', async () => {
  const f = await fixture(2000, 20000, false, 'gpt-6.1-sol');
  const body = {
    input: [{ type: 'additional_tools', id: 'tools', role: 'developer', tools: [{
      type: 'namespace', name: 'functions', description: 'Computer tools', tools: [
        { type: 'custom', name: 'exec', description: 'Run code', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
        { type: 'function', name: 'wait', strict: false, parameters: { type: 'object', properties: {} } },
      ],
    }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }],
    reasoning: { effort: 'low', context: 'all_turns' }, text: { verbosity: 'low' },
  };
  try {
    expect((await f.call({}, body)).status).toBe(200);
    await f.settled(); expect(f.received()).toBe(1);
    for (const invalid of [
      { ...body, text: { verbosity: 'unbounded' } },
      { ...body, reasoning: { effort: 'low', context: 'unknown' } },
      { ...body, input: [{ type: 'additional_tools', id: 'tools', role: 'developer', tools: [{ type: 'unknown' }] }] },
      { ...body, text: { verbosity: 'low', unknown: true } },
    ]) expect((await f.call({}, invalid)).status).toBe(403);
    expect(f.actor.state.reservations).toHaveLength(1); expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it('enforces reviewed tool modes at the real gateway, including the first automatic write', async () => {
  const f = await fixture();
  try {
    await f.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'alice' });
    await f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', connectionId: 'installed', accountMode: 'none', schemaDigest: 'a'.repeat(64), toolCount: 4,
      tools: [ { name: 'write', revision: 'a'.repeat(64), reviewed: true, costCents: 0 }, { name: 'read', revision: 'b'.repeat(64), reviewed: true, readOnly: true, costCents: 0 },
        { name: 'unpriced', revision: 'a'.repeat(64), reviewed: true },
        { name: 'new', revision: 'c'.repeat(64), reviewed: false } ] });
    await f.append('mcp-fixture', 'mcp.server_published', { serverId: 'fixture', publishedBy: 'alice' });
    for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
      const event = await f.append(grantStream('mcp_server', 'fixture'), 'grant.given', { resourceType: 'mcp_server', resourceId: 'fixture', granteeId, granteeKind, grantedBy: 'alice' });
      await f.auth.handler.handle(event, f.db);
    }
    const call = async (name: string, extra = {}, patch = {}) => {
      const response = await fetch(`http://127.0.0.1:${f.options.port}/mcp/fixture/installed`, { method: 'POST', headers: { ...f.headers,
        'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-tool-name': name, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
        method: 'tools/call', params: { name, arguments: { note: 'secret-canary' } },
        _meta: { 'io.modelcontextprotocol/protocol-version': '2026-07-28', 'io.modelcontextprotocol/client-capabilities': {} }, ...patch }) });
      return { status: response.status, text: await response.text() };
    };
    expect((await call('write')).status).toBe(403); expect(f.received()).toBe(0);
    const mode = (name: string, mode: string, revision = 'a'.repeat(64)) => f.append('mcp-fixture', 'mcp.tool_mode_set', {
      serverId: 'fixture', connectionId: 'installed', toolName: name, toolRevision: revision, mode, setBy: 'alice' });
    await mode('unpriced', 'allow');
    const unpriced = await call('unpriced');
    expect(unpriced.status).toBe(403); expect(unpriced.text).toContain('unknown_cost');
    await mode('write', 'allow');
    expect((await call('write')).status).toBe(200); expect(f.received()).toBe(1);
    await mode('read', 'ask', 'b'.repeat(64));
    const asked = await call('read');
    expect(asked.status).toBe(403); expect(asked.text).toContain('approval_required');
    await mode('write', 'block');
    for (const name of ['write', 'new', 'unknown', '__proto__', 'constructor', 'toString']) expect((await call(name)).status).toBe(403);
    expect(f.received()).toBe(1);
    expect(f.providerHeaders()).not.toContain('authorization');
    expect(f.providerHeaders()).not.toContain('x-turn-token');
    await until(() => f.admitted.length === 1);
    await mode('write', 'allow');
    for (const extra of [{ authorization: '' }, { 'x-turn-token': '' }, { 'session-id': 'other' }, { 'mcp-method': 'tools/list' },
      { 'x-turn-token': await f.sign({ ...f.t, requester: 'bob' }, 'decision-service') },
      { 'x-turn-token': await f.sign({ ...f.t, conversation: 'other' }, 'decision-service') },
      { 'x-turn-token': await f.sign({ ...f.t, silo: 'other' }, 'decision-service') },
      { 'x-turn-token': await f.sign(f.t, 'decision-service', -1) },
      { authorization: `Bearer ${await f.sign({ ...f.c, generation: 2 }, 'agentgateway')}` }]) {
      expect((await call('write', extra)).status).toBeGreaterThanOrEqual(400);
      if (!('mcp-method' in extra)) expect((await f.call(extra)).status).toBeGreaterThanOrEqual(400);
    }
    for (const patch of [{ _meta: {} }, { method: 'Tools/Call' }, { method: 'resources/read' }, { params: { name: 'read', arguments: {} } }]) {
      expect((await call('write', {}, patch)).status).toBe(403);
    }
    expect(f.received()).toBe(1);
    for (const [resourceType, resourceId, granteeId] of [['model', 'gpt-6-luna', 'alice'], ['model', 'gpt-6-luna', 'assistant'],
      ['mcp_server', 'fixture', 'alice'], ['mcp_server', 'fixture', 'assistant']]) {
      const start = performance.now();
      const revoke = await f.append(grantStream(resourceType!, resourceId!), 'grant.revoked', { resourceType, resourceId, granteeId, revokedBy: 'alice' });
      const invoke = resourceType === 'model' ? () => f.call() : () => call('write');
      expect((await invoke()).status).toBe(403); // Refuse while OpenFGA lags too.
      await f.auth.handler.handle(revoke, f.db);
      expect((await invoke()).status).toBe(403);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(f.received()).toBe(1);
      const restore = await f.append(grantStream(resourceType!, resourceId!), 'grant.given', { resourceType, resourceId, granteeId,
        granteeKind: granteeId === 'alice' ? 'member' : 'assistant', grantedBy: 'alice' });
      await f.auth.handler.handle(restore, f.db);
    }
    await f.append('assistant-assistant', 'assistant.settings_changed', { assistantId: 'assistant', changedBy: 'alice', changedFields: ['active'], active: false });
    expect((await call('write')).status).toBe(403); expect((await f.call()).status).toBe(403);
    expect(f.received()).toBe(1);
    await f.append('assistant-assistant', 'assistant.settings_changed', { assistantId: 'assistant', changedBy: 'alice', changedFields: ['active'], active: true });
    await fga.pause();
    try { expect((await call('write')).status).toBe(403); } finally { await fga.resume(); }
    const events = [];
    for await (const row of f.nats.store.subscribe()) {
      if (row.event.type === 'decision.recorded') events.push(row.event.data);
      if (row.sequence === await f.nats.store.head()) break;
    }
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'allow', reason: 'policy_allow', requesterId: 'alice', assistantId: 'assistant' }),
      expect.objectContaining({ outcome: 'ask', reason: 'approval_required' }), expect.objectContaining({ outcome: 'deny', reason: 'policy_block' })]));
    expect(JSON.stringify(events)).not.toContain('secret-canary');
    const append = f.nats.store.append.bind(f.nats.store);
    const fault = vi.spyOn(f.nats.store, 'append').mockImplementation(command => {
      if (z.object({ type: z.literal('decision.recorded') }).safeParse(command.event).success) return Promise.resolve({ status: 'unavailable', cause: new Error('Audit outage') });
      return append(command);
    });
    try {
      expect((await call('write')).status).toBe(503);
      expect((await f.call()).status).toBe(503); expect(f.received()).toBe(1);
    } finally { fault.mockRestore(); }
    await f.append('mcp-fixture', 'mcp.tools_changed', { serverId: 'fixture', previousSchemaDigest: 'a'.repeat(64), newSchemaDigest: 'd'.repeat(64) });
    expect((await call('write')).status).toBe(403); expect(f.received()).toBe(1);
    await f.append('mcp-fixture', 'mcp.server_published', { serverId: 'fixture', publishedBy: 'alice' });
    expect((await call('write')).status).toBe(403); expect(f.received()).toBe(1);
    await f.append('mcp-fixture', 'mcp.server_discovered', { serverId: 'fixture', connectionId: 'installed', accountMode: 'personal', schemaDigest: 'd'.repeat(64), toolCount: 1,
      tools: [{ name: 'write', revision: 'd'.repeat(64), reviewed: true }] });
    await f.append('mcp-fixture', 'mcp.server_published', { serverId: 'fixture', publishedBy: 'alice' });
    await mode('write', 'allow', 'd'.repeat(64));
    expect((await call('write')).status).toBe(403); expect(f.received()).toBe(1); // No fabricated personal profile.
    await f.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
    expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it('uses the current requester on a team assistant and refuses removed team membership before OpenFGA catches up', async () => {
  const f = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    const removed = await f.append('team-sales', 'team.member_removed', { teamId: 'sales', memberId: 'alice', removedBy: 'owner' });
    expect((await f.call()).status).toBe(403);
    await f.auth.handler.handle(removed, f.db);
    expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

// P3-13: all ceilings share the existing actor and the real dispatch path.
it.each(['global', 'paying_group', 'assistant'] as const)('serialises concurrent reservations at the %s monthly ceiling and replays one charge', async scope => {
  const f = await fixture(2000, 2000);
  try {
    await f.actor.configure({ scope, ...(scope === 'global' ? {} : { scopeId: scope === 'paying_group' ? 'personal-default' : 'assistant' }), ceilingCents: 25, setBy: 'alice' });
    const replies = await Promise.all(Array.from({ length: 2 }, () => f.call()));
    expect(replies.filter(r => r.status === 200), JSON.stringify(replies)).toHaveLength(1);
    expect(replies.filter(r => r.status === 402)).toHaveLength(1);
    expect(replies.find(r => r.status === 402)?.text).toContain(scope === 'global' ? 'Silo' : scope === 'paying_group' ? 'Paying group' : 'Assistant');
    expect(f.received()).toBe(1);
    await f.settled();
    expect(f.actor.state.reservations).toHaveLength(1);
    expect(f.actor.state.reservations[0]?.call.payingGroupId).toBe('personal-default');
    await f.runner.rebuild(budgets);
    expect(await readBudget(f.db, 'test')).toEqual(f.actor.state);
    expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);

it('resets at the exact UTC month boundary, holds unknown money and attributes late usage to the original group and month', async () => {
  const f = await fixture(2000, 2000);
  try {
    await f.actor.configure({ scope: 'paying_group', scopeId: 'personal-default', ceilingCents: 25, setBy: 'alice' });
    f.advance(Date.parse('2026-10-31T23:59:59.999Z') - f.actor.now().getTime());
    await f.runtime.stop();
    expect((await f.call()).status).toBe(200);
    const reservation = f.actor.state.reservations[0]!;
    f.advance(1);
    await f.actor.period();
    expect(totals(f.actor.state, f.actor.now())).toMatchObject({ monthCents: 0, reservedCents: 25 });
    expect((await f.call()).status).toBe(402);
    await f.actor.effect(reservation.id, { inputTokens: 1000, outputTokens: 120 });
    await f.actor.settleRecorded(reservation.id, `${reservation.id}:effect.observed`);
    expect(totals(f.actor.state, f.actor.now())).toMatchObject({ monthCents: 0, reservedCents: 0 });
    expect((await f.call()).status).toBe(200);
    f.advance(); await f.actor.expire();
    expect(totals(f.actor.state, f.actor.now()).reservedCents).toBe(25);
    const recovered = new BudgetActor(f.nats.store, 'test', f.actor.now); await recovered.start();
    expect(recovered.state.reservations[0]?.call).toEqual(reservation.call);
    await expect(f.actor.releaseUndispatched(recovered.state.reservations[1]!.id)).rejects.toThrow('lost its fence');
    await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(recovered.state);
    const periods = (await history(f.nats.store, 'budget-test', 'test')).filter(r => r.event.type === 'budget.period_started');
    expect(periods.at(-1)?.event.data).toEqual({ periodStart: '2026-11-01T00:00:00.000Z' });
    expect(f.received()).toBe(2);
  } finally { await f.close(); }
}, 40_000);

it('fixes multiplicity at one and gives a clear reason for absent, fractional, conflicting and unsupported bounds before dispatch', async () => {
  const f = await fixture();
  try {
    expect((await f.call({}, { n: 1 })).status).toBe(200); await f.settled();
    for (const patch of [{ n: 0 }, { n: 1.5 }, { n: 2 }, { max_output_tokens: undefined }, { max_output_tokens: -1 },
      { max_output_tokens: 0 }, { max_output_tokens: 1.5 }, { max_output_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { max_tokens: 128 }, { input_tokens: 1 }, { tools: [{ type: 'web_search' }] }]) {
      const refused = await f.call({}, patch);
      expect(refused.status).toBe(403); expect(refused.text).toContain('output bound');
    }
    expect(f.received()).toBe(1); expect(f.actor.state.reservations).toHaveLength(1);
  } finally { await f.close(); }
}, 40_000);

it('resets the daily safety cap at UTC midnight within a month while keeping outstanding reservations', async () => {
  const f = await fixture(25, 2000);
  try {
    f.advance(Date.parse('2026-10-03T23:59:59.999Z') - f.actor.now().getTime());
    expect((await f.call()).status).toBe(200); await f.settled();
    expect((await f.call()).status).toBe(402);
    f.advance(1); await f.actor.period();
    expect(totals(f.actor.state, f.actor.now())).toMatchObject({ todayCents: 0, monthCents: 1 });
    await f.runtime.stop();
    expect((await f.call()).status).toBe(200);
    f.advance(86400_000); await f.actor.expire();
    expect((await f.call()).status).toBe(402);
    expect(totals(f.actor.state, f.actor.now())).toMatchObject({ todayCents: 0, monthCents: 1, reservedCents: 25 });
    await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(f.actor.state);
    expect(f.received()).toBe(2);
  } finally { await f.close(); }
}, 40_000);
