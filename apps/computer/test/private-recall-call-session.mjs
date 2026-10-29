import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { privateCatalogue, privateToolOffer, checkPrivateTurnTools }
  from '../../server/test/support/private-catalogue.ts';
import { privateConfig, privateEnvironments } from '../src/codex-config.ts';
import { codexConnection } from '../src/codex-connection.ts';
import { parseTurn } from '../src/turn-frame.ts';

export async function recallSession(name, authority, loads, canary) {
  const home = await mkdtemp('/tmp/recall-call-');
  const input = parseTurn({ id: name, conversationId: 'chat', requesterId: 'alice',
    assistantId: 'assistant', executionMode: 'restricted', text: 'Recall once', token: 'fixture',
    expiresAt: Date.now() + 110_000, tools: privateToolOffer('recall') });
  const identity = { turnId: name, conversation: input.conversationId, generation: 1,
    inputGeneration: 1, expires: input.expiresAt };
  const registration = authority.register(identity);
  await writeFile(`${home}/config.toml`, privateConfig('gpt-6.1-sol'));
  await writeFile(`${home}/environments.toml`, privateEnvironments());
  const options = { cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
    PROXY_CALLER_TOKEN: registration.caller }, stdio: ['pipe', 'pipe', 'ignore'] };
  const child = spawn('/usr/local/bin/node',
    ['/usr/local/bin/codex', 'app-server', '--stdio', '--strict-config'], options);
  const ended = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let exposed = false;
  let nativeCall;
  let expectedThread;
  let expectedTurn;
  let consents = 0;
  function message(value, line) {
    if (line.includes(canary)) exposed = true;
    if (value.method === 'item/completed' && value.params.item.type === 'mcpToolCall') {
      nativeCall = value.params.item;
    }
    if (value.method === 'turn/started') expectedTurn = value.params.turn.id;
    if (value.method === 'turn/completed') completed.resolve(value.params.turn);
    if (value.id !== undefined) {
      if (value.method === 'mcpServer/elicitation/request') {
        assert.equal(value.params.threadId, expectedThread);
        assert.equal(value.params.turnId, expectedTurn);
        assert.equal(consents++, 0);
        assert.equal(value.params.serverName, privateToolOffer('recall')[0].key);
        assert.equal(value.params._meta.codex_approval_kind, 'mcp_tool_call');
        connection.respond({ id: value.id, result: { action: 'accept' } });
        return;
      }
      connection.reply(value.id, { code: -32601, message: 'Fixture refuses native requests' });
    }
  }
  function failed() { completed.reject(new Error('Native connection failed')); }
  const connection = codexConnection(child.stdin, child.stdout, { message, failed });
  function close() { ended.resolve(); }
  const session = { rpc: connection.rpc, close, closed: ended.promise };
  const owner = { ...identity, caller: registration.caller, authority, registration, session };
  async function prepare() {
    const initialise = { clientInfo: { name: 'recall-call-test', version: '1' },
      capabilities: { experimentalApi: true } };
    await connection.rpc('initialize', initialise);
    connection.notify('initialized', {});
    const started = await loads.startPrivate(input, owner);
    const grant = { ...identity, silo: 'test', requesterId: input.requesterId,
      assistantId: input.assistantId, computerId: 'computer', thread: started.thread.id };
    registration.bind(grant.thread);
    // Reuse synthetic preparation evidence; this does not qualify execution.
    const approval = await privateCatalogue(authority, registration.caller, grant);
    const binding = { ...owner, grant, tools: approval.tools, checkTools: checkPrivateTurnTools };
    const loaded = await loads.loadPrivate(input, binding);
    assert.equal(loaded.thread.id, grant.thread);
    assert.equal(loaded.thread.ephemeral, true);
    assert.equal(loaded.thread.path, null);
    assert.deepEqual(loaded.thread.environments, []);
    const listing = await connection.rpc('mcpServerStatus/list', { threadId: grant.thread });
    assert.equal(listing.data.length, 1);
    assert.deepEqual(Object.keys(listing.data[0].tools), ['recall']);
    return grant;
  }
  async function turn(threadId) {
    const input = [{ type: 'text', text: 'Recall once', text_elements: [] }];
    // Supply test-only native consent for this one MCP call; production admission stays off.
    expectedThread = threadId;
    await connection.rpc('turn/start', { threadId, input, approvalPolicy: 'on-request' });
    const result = await completed.promise;
    assert.equal(result.status, 'completed');
    assert.equal(nativeCall?.tool, 'recall');
    assert.equal(consents, 1);
    if (name === 'matching' || name === 'survivor') {
      assert.deepEqual(nativeCall.result.content, []);
      const recalled = nativeCall.result.structuredContent;
      assert.equal(recalled.facts.length, 1);
      assert.equal(recalled.facts[0].text, canary);
      assert.equal(recalled.recallProof, 'fixture-recall-proof');
    }
    return exposed;
  }
  async function dispose() {
    registration.close();
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    close();
    await rm(home, { recursive: true, force: true });
  }
  return { prepare, turn, dispose, registration };
}

export async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function sendEvent(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function scriptedRecall(request, response, state, scopeId, canary) {
  const body = await readJson(request);
  let output;
  for (const item of body.input ?? []) {
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)
      && item.call_id === state.callId) output = item;
  }
  state.modelRequests++;
  let item;
  if (!output) {
    assert.equal(state.modelRequests, 1);
    const argumentsText = JSON.stringify({ scopeId, query: 'fixture', limit: 1 });
    const key = privateToolOffer('recall')[0].key;
    item = { type: 'function_call', id: 'fc_recall', call_id: state.callId,
      name: 'recall', namespace: `mcp__${key}`, arguments: argumentsText };
  } else {
    state.consumed = Number(JSON.stringify(output).includes(canary));
    state.unconfirmed = JSON.stringify(output).includes('will not send it again');
    item = { type: 'message', id: 'finished', role: 'assistant',
      content: [{ type: 'output_text', text: 'Fixture finished.' }] };
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  sendEvent(response, { type: 'response.created', response: { id: 'fixture_response' } });
  sendEvent(response, { type: 'response.output_item.done', item });
  const completion = { type: 'response.completed', response: { id: 'fixture_response',
    status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
  sendEvent(response, completion);
  response.end();
}
