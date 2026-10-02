import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { natsFixture } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { HandlerRuntime, dispatch, provisionDispatcher } from '@opencrane/handlers';
import { pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { BudgetActor, budgets, costCents, envelope, history, ingestUsage, issuer, readBudget, settlementHandler, startDecision, startGateway, totals } from '../src/index.ts';

let fga: Awaited<ReturnType<typeof openfga>>;
beforeAll(async () => { fga = await openfga(); }, 120_000);
afterAll(async () => { await fga.close(); });
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function fixture(daily = 2000, monthly = 20000, real = false) {
  const directory = await mkdtemp(`${tmpdir()}/oc-models-`);
  const dbs = await databases(), nats = await natsFixture();
  const db = pgDb(dbs.queue), logger = createLogger('models-test', { level: 'silent' });
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const append = async (subject: string, type: string, payload: unknown) => {
    const event = envelope('test', subject, type, payload);
    const rows = await history(nats.store, subject, 'test');
    expect((await nats.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 })).status).toBe('appended');
    return event;
  };
  const joined = await append('member-alice', 'member.joined', { memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'owner' });
  await db.transaction(tx => auth.handler.handle(joined, tx));
  await append('assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' });
  await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'computer', podUid: 'pod', generation: 1 });
  await append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'computer' });
  await append('conversation-conversation', 'conversation.created', { conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice' });
  await append('conversation-conversation', 'agent.turn_started', { conversationId: 'conversation', assistantId: 'assistant', turnId: 'turn' });
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test' };
  const sign = (claims: Record<string, unknown>, audience: string, ttl = 120) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ttl).sign(privateKey);
  const c = { typ: 'computer', silo: 'test', computer: 'computer', assistant: 'assistant', generation: 1 };
  const t = { typ: 'turn', silo: 'test', assistant: 'assistant', conversation: 'conversation', turn: 'turn', requester: 'alice', thread: 'thread', delegation: ['alice'] };
  const headers = { authorization: `Bearer ${await sign(c, 'agentgateway')}`, 'x-turn-token': await sign(t, 'decision-service'), 'session-id': 'thread', 'content-type': 'application/json' };
  let clock = Date.now();
  const actor = new BudgetActor(nats.store, 'test', () => new Date(clock)); await actor.start(daily, monthly);
  const decision = await startDecision(actor, { keys: [jwk] }, binding);
  let received = 0, hold = false, providerHeaders: string[] = [], providerAuthHash = '';
  // S0.1c's scripted Responses stream, reduced to the final usage-bearing event.
  const stub = createServer((req, res) => {
    received++; providerHeaders = Object.keys(req.headers);
    providerAuthHash = createHash('sha256').update(req.headers.authorization ?? '').digest('hex');
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stub","object":"response","status":"in_progress"}}\n\n');
    if (hold) return;
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_stub', object: 'response', status: 'completed', model: 'gpt-5-nano',
      output: [], usage: { input_tokens: 1000, output_tokens: 120, total_tokens: 1120 } } })}\n\n`);
  });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  const address = stub.address(); if (!address || typeof address === 'string') throw new Error('No stub');
  const keyFile = real ? resolve('.keys/.openai-key') : `${directory}/stub-key`;
  if (!real) await writeFile(keyFile, 'stub-only-placeholder');
  const options = { binary: resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64'),
    configFile: `${directory}/gateway.json`, usageFile: `${directory}/usage.jsonl`, keyFile,
    port: await freePort(), readinessPort: await freePort(), decisionUrl: decision.url,
    ...(real ? {} : { upstream: `127.0.0.1:${address.port}` }) };
  let gateway = await startGateway(options);
  const runner = new ProjectionRunner(db, nats.store, logger); await runner.initialise(budgets);
  await provisionDispatcher(nats.connection);
  const runtime = new HandlerRuntime({ db, logger, silo: 'test', handlers: [settlementHandler(decision.url)], retryDelay: 1 });
  await runtime.start(); await runtime.work();
  const abort = new AbortController(); const dispatching = dispatch(nats.connection, runtime, abort.signal);
  void dispatching.catch(() => undefined);
  const body = { model: 'gpt-5-nano', input: 'Say OK.', max_output_tokens: 128, stream: true, store: false, reasoning: { effort: 'minimal' } };
  return { actor, append, headers, t, c, sign, options, runner, db, nats, runtime, auth,
    decisionDown: () => decision.close(), providerAuthHash: () => providerAuthHash,
    received: () => received, providerHeaders: () => providerHeaders, hold: () => { hold = true; }, advance: (ms = 181_000) => { clock += ms; },
    async call(extra = {}, patch: Record<string, unknown> = {}) {
      const response = await fetch(`http://127.0.0.1:${options.port}/v1/responses`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ ...body, ...patch }) });
      return { status: response.status, text: await response.text() };
    },
    async settled() {
      await until(async () => { await ingestUsage(actor, options.usageFile); return actor.state.reservations.every(r => r.settledCents !== undefined); });
      await runner.run(budgets);
    },
    async restart() { await gateway.stop('SIGKILL'); gateway = await startGateway(options); },
    async close() {
      await gateway.stop(); await decision.close(); stub.closeAllConnections(); await new Promise<void>(resolve => stub.close(() => resolve()));
      abort.abort(); await dispatching.catch(error => { if (!(error instanceof Error && error.name === 'AbortError')) throw error; });
      await runtime.stop(); await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}
it('settles streamed gateway usage exactly, strips identity, rebuilds PostgreSQL, and rejects invalid calls before the provider', async () => {
  const f = await fixture();
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    expect(f.actor.state.reservations[0]?.settledCents).toBe(costCents('gpt-5-nano', 1000, 120));
    expect(totals(await readBudget(f.db, 'test')).reservedCents).toBe(0);
    const before = await readBudget(f.db, 'test'); await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(before);
    expect(f.providerAuthHash()).toBe(createHash('sha256').update('Bearer stub-only-placeholder').digest('hex'));
    expect(f.providerHeaders()).not.toContain('x-turn-token'); expect(f.providerHeaders()).not.toContain('session-id');
    for (const bad of [{ 'session-id': 'other' }, { 'x-turn-token': 'forged' }, { authorization: 'Bearer forged' },
      { 'x-turn-token': await f.sign(f.t, 'decision-service', -1) }, { authorization: `Bearer ${await f.sign(f.c, 'agentgateway', -1)}` },
      { 'x-turn-token': await f.sign({ ...f.t, silo: 'other' }, 'decision-service') }]) expect((await f.call(bad)).status).toBeGreaterThanOrEqual(400);
    for (const patch of [{ model: 'other' }, { max_output_tokens: 0 }, { max_output_tokens: 2001 }, { max_output_tokens: null },
      { previous_response_id: 'old' }, { tools: [{ type: 'web_search' }] }, { service_tier: 'priority' }, { n: 2 },
      { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/a' }] }] }]) {
      expect((await f.call({}, patch)).status).toBe(403);
    }
    expect(f.received()).toBe(1);
    const duplicate = await fetch(`http://127.0.0.1:${f.options.port}/v1/responses`, { method: 'POST', headers: f.headers,
      body: '{"model":"gpt-5-mini","model":"gpt-5-nano","input":"OK","max_output_tokens":128,"stream":true}' });
    expect(duplicate.status).toBe(403); expect(f.received()).toBe(1);
    await fga.pause();
    try { expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1); } finally { await fga.resume(); }
    const removed = await f.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
    await f.db.transaction(tx => f.auth.handler.handle(removed, tx));
    expect((await f.call()).status).toBe(403); expect(f.received()).toBe(1);
    await f.decisionDown(); expect((await f.call()).status).toBe(503); expect(f.received()).toBe(1);
  } finally { await f.close(); }
}, 40_000);
it.each([[2, 2000], [2000, 2]])('admits one last reservation under daily %i / monthly %i cents and clearly refuses the next call', async (daily, monthly) => {
  const f = await fixture(daily, monthly);
  try {
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.call()));
    expect(replies.filter(r => r.status === 200)).toHaveLength(1); expect(f.received()).toBe(1);
    expect(replies.filter(r => r.status === 402)).toHaveLength(7); await f.settled();
    expect((await f.call()).text).toContain('spending cap reached');
  } finally { await f.close(); }
}, 40_000);
it('retains an in-flight reservation across gateway kill and actor recovery, recording uncertainty after timeout', async () => {
  const f = await fixture(2, 200);
  try {
    f.hold(); const call = f.call().catch(() => ({ status: 502 }));
    await until(() => f.received() === 1); await f.restart(); await call;
    f.advance(); await f.actor.expire();
    const r = f.actor.state.reservations[0]!;
    expect((await history(f.nats.store, `effect-${r.id}`, 'test')).map(r => r.event.type)).toContain('effect.uncertain');
    const recovered = new BudgetActor(f.nats.store, 'test'); await recovered.start();
    expect(totals(recovered.state).reservedCents).toBe(2);
    expect((await f.call()).status).toBe(403); // The old actor cannot append after the replacement's fence.
    await f.runner.rebuild(budgets); expect(totals(await readBudget(f.db, 'test')).reservedCents).toBe(2);
  } finally { await f.close(); }
}, 40_000);
it('leaves money reserved on settlement failure and retries the recorded effect idempotently', async () => {
  const f = await fixture();
  try {
    await f.runtime.stop(); expect((await f.call()).status).toBe(200);
    await until(async () => { await ingestUsage(f.actor, f.options.usageFile); return (await history(f.nats.store, `effect-${f.actor.state.reservations[0]!.id}`, 'test')).length > 0; });
    expect(totals(f.actor.state).reservedCents).toBe(2);
    const r = f.actor.state.reservations[0]!;
    await expect(f.actor.settleRecorded(r.id, randomUUID())).rejects.toThrow('Effect not recorded');
    const effect = (await history(f.nats.store, `effect-${r.id}`, 'test'))[0]!.event;
    const replacement = new BudgetActor(f.nats.store, 'test'); await replacement.start();
    await expect(f.actor.settle(effect)).rejects.toThrow('lost its fence');
    expect(totals(f.actor.state).reservedCents).toBe(2);
    await replacement.settle(effect); await replacement.settle(effect);
    expect(totals(replacement.state).reservedCents).toBe(0);
    expect((await history(f.nats.store, 'budget-test', 'test')).filter(r => r.event.type === 'budget.settled')).toHaveLength(1);
  } finally { await f.close(); }
}, 40_000);
it('rolls UTC periods without forgetting outstanding reservations', async () => {
  const f = await fixture(2, 20);
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    f.advance(32 * 86400_000);
    expect(totals(f.actor.state, f.actor.now())).toMatchObject({ todayCents: 0, monthCents: 0 });
    const call = f.actor.state.reservations[0]!.call;
    await f.actor.reserve(call, 2); f.advance(32 * 86400_000);
    expect(totals(f.actor.state, f.actor.now()).reservedCents).toBe(2);
    await expect(f.actor.reserve(call, 2)).rejects.toThrow('spending cap');
    await f.runner.rebuild(budgets); expect(await readBudget(f.db, 'test')).toEqual(f.actor.state);
  } finally { await f.close(); }
}, 40_000);
it.runIf(process.env['MODELS_REAL_CALL'] === '1')('makes exactly one real OpenAI call and records only tokens and cents', async () => {
  const f = await fixture(2000, 20000, true);
  try {
    expect((await f.call()).status).toBe(200); await f.settled();
    const usage: unknown = JSON.parse((await readFile(f.options.usageFile, 'utf8')).trim());
    await writeFile('.tools/models-real-receipt.json', JSON.stringify({ model: 'gpt-5-nano', usage,
      costCents: f.actor.state.reservations[0]?.settledCents, calls: f.actor.state.reservations.length }, null, 2));
    expect(f.actor.state.reservations).toHaveLength(1);
  } finally { await f.close(); }
}, 120_000);
