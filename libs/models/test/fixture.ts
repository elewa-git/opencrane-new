import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { computerCredentials, tokenIssuer } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation, grantStream } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { HandlerRuntime, dispatch, provisionDispatcher } from '@opencrane/handlers';
import { conversationKeys, pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { modelGrantHandler, BudgetActor, budgets, envelope, history, ingestUsage, models, settlementHandler, startDecision, startGateway } from '../src/index.ts';

export let fga: Awaited<ReturnType<typeof openfga>>;
beforeAll(async () => { fga = await openfga(); }, 120_000);
afterAll(async () => { await fga.close(); });
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export async function waitForModelGrants(auth: ReturnType<typeof memberAuthorisation>, memberId: string, assistantId: string) {
  await until(async () => (await Promise.all(models.filter(m => !m.retired).flatMap(model => [
    auth.use('person', memberId, 'model', model.id), auth.use('assistant', assistantId, 'model', model.id),
  ]))).every(result => result.allowed));
}
export async function fixture(daily = 2000, monthly = 20000, real = false, allowedModel = 'gpt-6-luna', team = false, grants: 'manual' | 'reactions' | 'legacy' = 'manual') {
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
  const keys = conversationKeys(`${directory}/keys`); keys.provision('test', 'conversation');
  const decision = await startDecision(actor, { jwks: { keys: [jwk] }, issuer }, binding, 0, keys);
  let usage = { input_tokens: 1000, output_tokens: 120, total_tokens: 1120, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  const admitted: string[] = [], observations: Promise<void>[] = [];
  let upstreamBody = '';
  let received = 0, hold = false, rejection = 0, providerHeaders: string[] = [], providerAuthHash = '';
  // S0.1c's scripted Responses stream, reduced to the final usage-bearing event.
  const stub = createServer((req, res) => {
    const requestId = String(req.headers['x-request-id']);
    observations.push(history(nats.store, `decision-${requestId}`, 'test').then(rows => {
      if (rows.some(r => r.event.type === 'decision.recorded' && z.object({ outcome: z.literal('allow') }).safeParse(r.event.data).success)) admitted.push(requestId);
    }));
    received++; providerHeaders = Object.keys(req.headers);
    providerAuthHash = createHash('sha256').update(req.headers.authorization ?? '').digest('hex');
    req.on('data', (chunk: Buffer) => { upstreamBody += chunk.toString('utf8'); });
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
  // The stub's 1,000 input tokens must fit within the request's byte bound.
  const body = { model: allowedModel, input: real ? 'Say OK.' : 'Say OK.'.repeat(150), max_output_tokens: 128, stream: true, store: false, reasoning: { effort: 'minimal' } };
  return { keys, upstreamBody: () => upstreamBody, actor, append, headers, t, c, sign, issue, credentials, binding, identity: { jwks: { keys: [jwk] }, issuer },
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
      await runtime.stop(); await Promise.all(observations); await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}
