import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { losslessJson } from '@opencrane/events/lossless-json';
import { grantStream } from '@opencrane/authz';
import { history, readToolPolicy } from '@opencrane/models';
import { fixture, reviewCatalogue, catalogueEvidence } from '@opencrane/models/testing';
import { buildTurnTools } from '../apps/server/src/chat/turn-tools.ts';
import { createDemoServer } from '../apps/demo-mcp/src/server.ts';
import { catalogue } from '../apps/demo-mcp/src/tools.ts';

const execute = promisify(execFile);
const image = process.env.CODEX_CAPTURE_IMAGE ?? 'ocn-upload-computer:test';

async function publishRead(setup) {
  const tools = [];
  for (const definition of catalogue.tools) {
    const parsed = losslessJson(JSON.stringify(definition));
    const tool = { name: definition.name, definition: parsed.canonical, revision: parsed.digest,
      readOnly: definition.annotations.readOnlyHint,
      destructive: definition.annotations.destructiveHint,
      reviewed: true, costCents: 0, review: definition._meta['io.opencrane/review'] };
    tools.push(tool);
  }
  await setup.append('mcp-fixture', 'mcp.server_registered', { serverId: 'fixture',
    kind: 'remote', locator: 'https://mcp.example.test/', registeredBy: 'alice' });
  const discovered = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogueEvidence(tools) };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovered);
  await reviewCatalogue(setup);
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', { serverId: 'fixture',
    connectionId: 'installed', toolName: tools[0].name, toolRevision: tools[0].revision,
    mode: 'allow', setBy: 'alice' });
  await setup.append('mcp-fixture', 'mcp.server_published',
    { serverId: 'fixture', publishedBy: 'alice' });
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture', granteeId,
      granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
  async function readServer(serverId) {
    const policy = await readToolPolicy(setup.nats.store, 'test', serverId);
    expect(policy.published).toBe(true);
    return { ...policy, serverId, discoveryTools: policy.catalogue.tools, policyTools: policy.tools };
  }
  async function canUse(serverId, kind, subject) {
    const result = await setup.auth.use(kind, subject, 'mcp_server', serverId);
    return result.allowed;
  }
  return buildTurnTools({ rows: [{ serverId: 'fixture' }], requesterId: 'alice',
    assistantId: 'assistant', baseMessageBytes: 100, readServer, canUse });
}

async function readBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function forward(incoming, response, destination, replies) {
  const options = { method: incoming.method, headers: incoming.headers };
  function receive(upstream) {
    const chunks = [];
    function chunk(value) { chunks.push(value); }
    function finished() {
      if (replies) replies.push(Buffer.concat(chunks).toString());
    }
    function interrupted() { response.destroy(); }
    upstream.on('error', interrupted);
    upstream.on('data', chunk);
    upstream.on('close', finished);
    response.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(response);
  }
  const outgoing = request(destination, options, receive);
  function failed() { response.destroy(); }
  outgoing.on('error', failed);
  incoming.pipe(outgoing);
}

async function startProvider(context) {
  const { directory, demo, dispatches, replies, servers, setup } = context;
  const env = { ...process.env, MODEL_STUB_PORT: '0', MODEL_STUB_MCP_REVISION: 'fixture',
    MODEL_STUB_MCP_GENERATION: 'fixture', MODEL_STUB_CAPTURE: `${directory}/requests.jsonl` };
  context.stub = spawn(process.execPath, ['--experimental-strip-types',
    resolve('infra/dev-stack/model-stub.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const [ready] = await once(context.stub.stdout, 'data');
  const port = /Stub ready (\d+)/u.exec(ready.toString())?.[1];
  assert(port);
  await demo.listen({ host: '127.0.0.1', port: 0 });
  function upstream(incoming, response) {
    if (incoming.url.startsWith('/mcp/')) {
      dispatches.push({ name: incoming.headers['mcp-name'],
        requestId: incoming.headers['x-request-id'] });
      forward(incoming, response, `http://127.0.0.1:${demo.server.address().port}/`);
    } else {
      forward(incoming, response, `http://127.0.0.1:${port}${incoming.url}`, replies);
    }
  }
  const provider = createServer(upstream);
  servers.push(provider);
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerAddress = `127.0.0.1:${provider.address().port}`;
  setup.options.upstream = providerAddress;
  setup.options.mcpRoutes[0].upstream = providerAddress;
  await setup.restart();
}

async function startRelay(context) {
  const { directory, modelRequests, servers, setup } = context;
  async function handle(incoming, response) {
    if (incoming.url === '/bind') {
      const binding = JSON.parse(await readBody(incoming));
      await setup.append('computer-assistant', 'computer.turn_started', {
        assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
        turnId: binding.turnId, threadId: binding.thread, requesterId: 'alice',
        task: 'chat_turn', payingGroupId: 'personal-default', executionMode: 'memory_free' });
      await setup.append('conversation-conversation', 'agent.turn_started', {
        conversationId: 'conversation', assistantId: 'assistant', turnId: binding.turnId });
      const claims = { ...setup.t, turn: binding.turnId, thread: binding.thread };
      const token = await setup.sign(claims, 'decision-service');
      response.end(JSON.stringify({ token, computer: setup.headers.authorization.slice(7) }));
      return;
    }
    forward(incoming, response, `http://127.0.0.1:${setup.options.port}${incoming.url}`);
  }
  function serve(incoming, response) {
    if (incoming.url === '/v1/responses') {
      const chunks = [];
      function chunk(value) { chunks.push(value); }
      function finished() { modelRequests.push(JSON.parse(Buffer.concat(chunks).toString())); }
      incoming.on('data', chunk);
      incoming.on('end', finished);
    }
    function failed(error) { response.destroy(error); }
    void handle(incoming, response).catch(failed);
  }
  const relay = createServer(serve);
  servers.push(relay);
  relay.listen(`${directory}/gateway.sock`);
  await once(relay, 'listening');
  await chmod(`${directory}/gateway.sock`, 0o666);
}

async function runComputer(context) {
  const { container, directory, home } = context;
  const args = ['run', '--rm', '--name', container, '--network', 'none',
    '-v', `${resolve('.')}:/source:ro`, '-v', `${directory}:/capture`,
    '-e', `CAPTURE_MISSING_HOME=${home === 'missing' ? '1' : '0'}`,
    '-e', `CAPTURE_UID=${process.getuid()}`, '-e', `CAPTURE_GID=${process.getgid()}`,
    '--entrypoint', 'node', image, '--experimental-strip-types',
    '/source/infra/dev-stack/test/stage-b-codex.mjs'];
  await execute('docker', args, { timeout: 70_000, maxBuffer: 1024 * 1024 });
}

async function assertReadResult(context, tools) {
  const { directory, home, dispatches, replies, setup } = context;
  const capture = JSON.parse(await readFile(`${directory}/codex.json`, 'utf8'));
  expect(capture.error).toBeUndefined();
  expect(capture.executorHomePresent).toBe(home === 'existing');
  expect(capture.turn, JSON.stringify(capture.turn)).toMatchObject({ status: 'completed' });
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0].name).toBe('read_fixture_quote');
  const requests = await readFile(`${directory}/requests.jsonl`, 'utf8');
  const lines = requests.trim().split('\n');
  expect(lines).toHaveLength(2);
  const first = JSON.parse(lines[0]);
  const offered = [];
  for (const item of first.input) {
    if (item.type === 'additional_tools') offered.push(...item.tools);
  }
  expect(offered).toContainEqual(expect.objectContaining({ name: 'functions',
    tools: expect.arrayContaining([expect.objectContaining({ name: 'exec', type: 'custom' })]) }));
  expect(lines[1]).toContain(`mcp__${tools[0].key}__read_fixture_quote`);
  expect(lines[1]).toContain('12500');
  expect(lines[1]).toContain('morning');
  expect(replies[0]).toContain('response.completed');
  expect(replies[1]).toContain('12500');
  const answers = [];
  for (const notification of capture.notifications) {
    if (notification.method !== 'item/completed') continue;
    if (notification.params.item.type !== 'agentMessage') continue;
    expect(notification.params.turnId).toBe(capture.turn.id);
    answers.push(notification.params.item.text);
  }
  expect(answers).toContain(
    'Quote DEMO-001: 12500 euro cents, morning delivery. Recorded effects: 0.');
  await setup.settled();
  const rows = await history(setup.nats.store, `decision-${dispatches[0].requestId}`, 'test');
  function dispatched(row) { return row.event.type === 'tool.dispatch_recorded'; }
  const saved = rows.filter(dispatched);
  expect(saved).toHaveLength(1);
  expect(saved[0].event.data).toMatchObject({ serverId: 'fixture',
    turnId: 'read-turn', toolName: 'read_fixture_quote', outcome: 'responded' });
}

function absent(error) {
  if (error.code === 'ENOENT') return '';
  throw error;
}
function removed(error) {
  if (error.stderr?.includes('No such container')) return;
  throw error;
}

async function saveEvidence(context) {
  const { directory, home, modelRequests, replies, dispatches } = context;
  if (process.env.STAGE_B_READ_EVIDENCE) {
    const destination = resolve(process.env.STAGE_B_READ_EVIDENCE, home);
    await mkdir(destination, { recursive: true });
    for (const name of ['codex.json', 'requests.jsonl']) {
      const bytes = await readFile(`${directory}/${name}`).catch(absent);
      await writeFile(`${destination}/${name}`, bytes, { mode: 0o600 });
    }
    await writeFile(`${destination}/model-requests.json`, JSON.stringify(modelRequests, null, 2),
      { mode: 0o600 });
    await writeFile(`${destination}/replies.json`, JSON.stringify(replies, null, 2));
    await writeFile(`${destination}/dispatches.json`, JSON.stringify(dispatches, null, 2));
  }
}

async function closeFixture(context) {
  const { container, stub, servers, demo, setup, directory } = context;
  await execute('docker', ['rm', '-f', '-v', container]).catch(removed);
  if (stub) {
    const exited = once(stub, 'exit');
    stub.kill('SIGTERM');
    await exited;
  }
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await demo.close();
  await setup.close();
  await rm(directory, { recursive: true, force: true });
}

async function publishedReadTurn(home) {
  const setup = await fixture(2000, 20000, false, 'gpt-6.1-sol');
  const directory = await mkdtemp(`${tmpdir()}/stage-b-read-`);
  const context = { setup, directory, home, container: `stage-b-read-${process.pid}-${home}`,
    replies: [], modelRequests: [], dispatches: [], servers: [], demo: createDemoServer() };
  try {
    const tools = await publishRead(setup);
    expect(tools).toHaveLength(1);
    expect(tools[0].modes).toEqual({ read_fixture_quote: 'allow' });
    await writeFile(`${directory}/tools.json`, JSON.stringify(tools), { mode: 0o600 });
    await startProvider(context);
    await startRelay(context);
    await runComputer(context);
    await assertReadResult(context, tools);
  } finally {
    try {
      await saveEvidence(context);
    } finally {
      await closeFixture(context);
    }
  }
}
it.each(['existing', 'missing'])(
  'answers the first published read after one dispatch with an %s executor home',
  publishedReadTurn, 120_000);
