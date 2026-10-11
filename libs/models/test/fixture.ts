import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import type { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, onTestFinished } from 'vitest';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { computerCredentials, tokenIssuer } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { createStore, memberAuthorisation, grantStream } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { HandlerRuntime, dispatch, provisionDispatcher } from '@opencrane/handlers';
import { conversationKeys, pgDb, ProjectionRunner } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { reviewToolPolicy, readToolPolicy, modelGrantHandler, BudgetActor, budgets, envelope, history, ingestUsage, models, settlementHandler, startDecision, startGateway } from '../src/index.ts';

export let fga: Awaited<ReturnType<typeof openfga>>;
beforeAll(async () => { fga = await openfga(); }, 120_000);
afterAll(async () => { await fga.close(); });

function registerGatewayCleanup(
  child: ChildProcess,
  stop: (signal?: NodeJS.Signals) => Promise<void>,
) {
  function removeSignalHandlers() {
    process.removeListener('SIGTERM', stopOnSigterm);
    process.removeListener('SIGINT', stopOnSigint);
  }
  async function stopChild() {
    await stop('SIGKILL');
    removeSignalHandlers();
  }
  async function stopChildAndForwardSignal(signal: NodeJS.Signals) {
    await stopChild();
    process.kill(process.pid, signal);
  }
  function stopOnSigterm() {
    void stopChildAndForwardSignal('SIGTERM');
  }
  function stopOnSigint() {
    void stopChildAndForwardSignal('SIGINT');
  }
  process.once('SIGTERM', stopOnSigterm);
  process.once('SIGINT', stopOnSigint);
  child.once('close', removeSignalHandlers);
  if (expect.getState().currentTestName) {
    onTestFinished(stopChild);
  } else {
    afterAll(stopChild);
  }
}
async function freePort() {
  const server = createServer(); server.listen(0, '::'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
export async function waitForModelGrants(auth: ReturnType<typeof memberAuthorisation>, memberId: string, assistantId: string) {
  await until(async () => (await Promise.all(models.filter(m => !m.retired).flatMap(model => [
    auth.use('person', memberId, 'model', model.id), auth.use('assistant', assistantId, 'model', model.id),
  ]))).every(result => result.allowed));
}
export async function fixture(daily = 2000, monthly = 20000, real = false,
  allowedModel = 'gpt-6-luna', team = false,
  grants: 'manual' | 'reactions' | 'legacy' = 'manual', teamPayer: string | null = 'sales',
  executionMode?: 'restricted' | 'memory_free') {
  const directory = await mkdtemp(`${tmpdir()}/oc-models-`);
  const dbs = await databases(), nats = await natsFixture();
  const db = pgDb(dbs.queue), logger = createLogger('models-test', { level: 'silent' });
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const append = async (subject: string, type: string, payload: unknown) => {
    let data = payload;
    if (type === 'mcp.server_discovered') {
      const checkedAt = new Date().toISOString();
      const evidence = { checkedAt,
        expiresAt: new Date(Date.parse(checkedAt) + 300_000).toISOString() };
      data = { ...evidence, ...z.record(z.string(), z.unknown()).parse(payload) };
    }
    const event = { ...envelope('test', subject, type, data), source: 'opencrane-server' };
    // Seed saved history, including old participant subjects that commands now refuse.
    const savedHistory = [event];
    await nats.seed(savedHistory);
    if (['assistant.created', 'conversation.created', 'team.created', 'team.member_added'].includes(type)) await auth.handler.handle(event, db);
    return event;
  };
  const joined = await append('member-alice', 'member.joined', { memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'owner' });
  await db.transaction(tx => auth.handler.handle(joined, tx));
  if (team) {
    await append('team-sales', 'team.created', { teamId: 'sales', name: 'Sales', createdBy: 'alice' });
    await append('team-sales', 'team.member_added', { teamId: 'sales', memberId: 'alice', addedBy: 'alice' });
  }
  const assistant = { assistantId: 'assistant', ownerId: team ? 'sales' : 'alice',
    kind: team ? 'team' : 'personal', payingGroupId: undefined as string | undefined };
  if (team && teamPayer !== null) assistant.payingGroupId = teamPayer;
  await append('assistant-assistant', 'assistant.created', assistant);
  await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'computer', tokenId: 'token:initial', generation: 1 });
  await append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'computer', generation: 1, podUid: 'pod' });
  await append('conversation-conversation', 'conversation.created', { conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
    ...(team ? { payingGroupId: 'sales' } : {}) });
  await append('conversation-conversation', 'agent.turn_started', { conversationId: 'conversation', assistantId: 'assistant', turnId: 'turn' });
  await append('computer-assistant', 'computer.turn_started', { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation', turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn', payingGroupId: team ? 'sales' : 'personal-default',
    ...(executionMode === undefined ? {} : { executionMode }) });
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
  const decision = await startDecision(actor, { jwks: { keys: [jwk] }, issuer, memory: tokens }, binding, 0, keys);
  let usage = { input_tokens: 1000, output_tokens: 120, total_tokens: 1120, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
  const admitted: string[] = [], observations: Promise<void>[] = [];
  let upstreamBody = '';
  let mcpResponse = { status: 200, marker: false, body: '{"jsonrpc":"2.0","id":1,"result":{"content":[]}}' };
  let received = 0, hold = false, rejection = 0, providerHeaders: string[] = [], providerAuthHash = '';
  const providerRequests: {
    time: string;
    path: string;
    method: string;
    correlationHeaders: Record<string, string | string[] | undefined>;
    bodyDigest: string;
    mcpName: string | string[] | undefined;
  }[] = [];
  // S0.1c's scripted Responses stream, reduced to the final usage-bearing event.
  const stub = createServer((req, res) => {
    const requestId = String(req.headers['x-request-id']);
    observations.push(history(nats.store, `decision-${requestId}`, 'test').then(rows => {
      if (rows.some(r => r.event.type === 'decision.recorded' && z.object({ outcome: z.literal('allow') }).safeParse(r.event.data).success)) admitted.push(requestId);
    }));
    received++; providerHeaders = Object.keys(req.headers);
    providerAuthHash = createHash('sha256').update(req.headers.authorization ?? '').digest('hex');
    const body: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { upstreamBody += chunk.toString('utf8'); body.push(chunk); });
    req.on('end', () => providerRequests.push({ time: new Date().toISOString(), path: req.url ?? '', method: req.method ?? '',
      correlationHeaders: Object.fromEntries(Object.entries(req.headers).filter(([name]) => /(?:request-id|correlation|traceparent|audit-id)/i.test(name))),
      mcpName: req.headers['mcp-name'],
      bodyDigest: createHash('sha256').update(Buffer.concat(body)).digest('hex') }));
    req.resume();
    if (req.url?.startsWith('/mcp/')) {
      res.setHeader('content-type', 'application/json');
      if (mcpResponse.marker) res.setHeader('x-opencrane-decision', 'refused');
      res.writeHead(mcpResponse.status);
      res.end(mcpResponse.body);
      return;
    }
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
  function closeUpstream() {
    stub.closeAllConnections();
    const closed = once(stub, 'close');
    stub.close();
    return closed;
  }
  const upstreamPort = address.port;
  async function resumeUpstream() {
    stub.listen(upstreamPort, '127.0.0.1');
    await once(stub, 'listening');
  }
  let options = { binary: resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64'),
    configFile: `${directory}/gateway.json`, usageFile: `${directory}/usage.jsonl`, keyFile,
    port: await freePort(), readinessPort: await freePort(), decisionUrl: decision.url, issuer,
    mcpRoutes: [{ serverId: 'fixture', connectionId: 'installed', upstream: `127.0.0.1:${address.port}` }],
    ...(real ? {} : { upstream: `127.0.0.1:${address.port}` }),
    onChildSpawn: registerGatewayCleanup };
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  for (let attempt = 0; ; attempt++) {
    try {
      gateway = await startGateway(options);
      break;
    } catch (error) {
      const isAddressConflict = error instanceof Error &&
        /address (?:already )?in use/iu.test(error.message);
      if (!isAddressConflict || attempt >= 2) {
        throw error;
      }
      options = { ...options, port: await freePort(), readinessPort: await freePort() };
    }
  }
  const runner = new ProjectionRunner(db, nats.store, logger); await runner.initialise(budgets);
  await provisionDispatcher(nats.connection);
  const runtime = new HandlerRuntime({ db, logger, silo: 'test', handlers: [settlementHandler(decision.url), ...(grants === 'reactions' ? [modelGrantHandler(nats.store), auth.handler] : [])], retryDelay: 1 });
  await runtime.start(); await runtime.work();
  const abort = new AbortController(); const dispatching = dispatch(nats.connection, runtime, abort.signal);
  void dispatching.catch(() => undefined);
  if (grants === 'reactions') await waitForModelGrants(auth, 'alice', 'assistant');
  const stopDispatch = async () => {
    abort.abort();
    await dispatching.catch(error => { if (!(error instanceof Error && error.name === 'AbortError')) throw error; });
  };
  // The stub's 1,000 input tokens must fit within the request's byte bound.
  const body = { model: allowedModel, input: real ? 'Say OK.' : 'Say OK.'.repeat(150), max_output_tokens: 128, stream: true, store: false, reasoning: { effort: 'minimal' } };
  return { tokens, keys, stopDispatch, closeUpstream, resumeUpstream,
    upstreamBody: () => upstreamBody, actor, append, headers, t, c, sign, issue, credentials, binding, identity: { jwks: { keys: [jwk] }, issuer },
    gatewayHealthy: () => gateway.healthy(),
    credentialTime: (offset: number) => { credentialClock += offset; }, options, runner, db, nats, runtime, auth,
    decisionDown: () => decision.close(), providerAuthHash: () => providerAuthHash,
    usage: (input: number, cached: number, output: number, writes = 0) => { usage = { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: cached, cache_write_tokens: writes } }; },
    mcpReply(status: number, marker: boolean, body: string) {
      mcpResponse = { status, marker, body };
    },
    reject: (status: number) => { rejection = status; },
    admitted, received: () => received, providerRequests: () => providerRequests, providerHeaders: () => providerHeaders, hold: () => { hold = true; }, advance: (ms = 181_000) => { clock += ms; },
    async call(extra = {}, patch: Record<string, unknown> = {}, path = '/v1/responses') {
      let requestBody = patch;
      if (path === '/v1/responses') {
        requestBody = { ...body, ...patch };
      }
      const request = { method: 'POST', headers: { ...headers, ...extra },
        body: JSON.stringify(requestBody) };
      const response = await fetch(`http://127.0.0.1:${options.port}${path}`, request);
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
      function stopSlowGateway() {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
      function slowGatewayHealthy() {
        return child.exitCode === null && child.signalCode === null;
      }
      async function stopSlowGatewayNormally() {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      }
      function removeSlowGatewaySignalHandlers() {
        process.removeListener('SIGTERM', stopSlowGatewayOnSigterm);
        process.removeListener('SIGINT', stopSlowGatewayOnSigint);
      }
      function stopSlowGatewayOnSigterm() {
        stopSlowGateway();
        process.kill(process.pid, 'SIGTERM');
      }
      function stopSlowGatewayOnSigint() {
        stopSlowGateway();
        process.kill(process.pid, 'SIGINT');
      }
      process.once('SIGTERM', stopSlowGatewayOnSigterm);
      process.once('SIGINT', stopSlowGatewayOnSigint);
      child.once('close', removeSlowGatewaySignalHandlers);
      if (expect.getState().currentTestName) {
        onTestFinished(stopSlowGateway);
      } else {
        afterAll(stopSlowGateway);
      }
      const exited = once(child, 'exit');
      gateway = {
        healthy: slowGatewayHealthy,
        stop: stopSlowGatewayNormally,
      };
      await until(async () => {
        try { return (await fetch(`http://127.0.0.1:${options.readinessPort}/healthz/ready`)).ok; }
        catch { return false; }
      });
    },
    // Replay checks drain completed requests; crash checks explicitly request SIGKILL.
    async restart(signal: NodeJS.Signals = 'SIGTERM') { await gateway.stop(signal); gateway = await startGateway(options); },
    async close() {
      await gateway.stop(); await decision.close(); stub.closeAllConnections(); await new Promise<void>(resolve => stub.close(() => resolve()));
      await stopDispatch();
      await runtime.stop(); await Promise.all(observations); await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}

type CatalogueTool = NonNullable<ReturnType<typeof mcpServerDiscoveredDataSchema.parse>['tools']>[number];

export function toolEvidence(tool: Omit<CatalogueTool, 'revision' | 'definition'>): CatalogueTool {
  const annotations = { readOnlyHint: tool.readOnly === true,
    destructiveHint: tool.destructive === true };
  const definition = { name: tool.name, inputSchema: { type: 'object' }, annotations };
  const encoded = JSON.stringify(definition);
  const parsed = losslessJson(encoded);
  return { ...tool, definition: parsed.canonical, revision: parsed.digest };
}

export function catalogueEvidence(tools: CatalogueTool[]) {
  return { tools, toolCount: tools.length, schemaDigest: catalogueDigest(tools) };
}

export async function reviewCatalogue(setup: Awaited<ReturnType<typeof fixture>>,
  serverId = 'fixture') {
  const state = await readToolPolicy(setup.nats.store, 'test', serverId);
  const catalogue = state.catalogue!;
  function choice(tool: NonNullable<typeof catalogue.tools>[number]) {
    return { name: tool.name, revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode: 'block' };
  }
  const command = { commandId: `review-${serverId}-${state.sequence}`,
    expectedSequence: state.sequence,
    policyRevision: state.policyRevision, catalogueDigest: catalogue.schemaDigest,
    connectionId: state.connectionId, accountMode: state.accountMode,
    tools: catalogue.tools!.map(choice) };
  const result = await reviewToolPolicy(setup.nats.store, setup.auth.binding, 'alice',
    serverId, command);
  expect(result.status).toBe('appended');
}
