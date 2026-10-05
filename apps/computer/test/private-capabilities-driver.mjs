import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { codexConnection } from '/app/src/codex-connection.ts';

const reply = 'Private capability fixture reply.';
let requests = 0;
function emit(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
async function serve(request, response) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(request.url, '/v1/responses');
  assert.deepEqual(input.tools ?? [], []);
  requests++;
  const id = 'response-fixture';
  const item = { id: 'message-fixture', type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: reply }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit(response, { type: 'response.created', response: { id } });
  emit(response, { type: 'response.output_item.added', output_index: 0,
    item: { ...item, content: [] } });
  emit(response, { type: 'response.output_text.delta', item_id: item.id,
    output_index: 0, content_index: 0, delta: reply });
  emit(response, { type: 'response.output_item.done', output_index: 0, item });
  emit(response, { type: 'response.completed', response: { id, status: 'completed',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  response.end();
}
function receive(request, response) {
  function failed(error) {
    process.stderr.write(String(error) + '\n');
    response.destroy();
  }
  void serve(request, response).catch(failed);
}
const provider = createServer(receive);
provider.listen(3000, '127.0.0.1');
await once(provider, 'listening');
const deadline = Date.now() + 15_000;
while (!existsSync('/run/executor/private.sock') && Date.now() < deadline) {
  await delay(25);
}
assert.ok(existsSync('/run/executor/private.sock'), 'supervisor must become ready');
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
const socket = connect('/run/executor/private.sock');
const notifications = [];
function received(message) {
  if (message.id !== undefined && typeof message.method === 'string') {
    connection.reply(message.id, { code: -32601, message: 'Private tools unavailable' });
    return;
  }
  notifications.push(message);
}
function failed() {
  socket.destroy();
}
const connection = codexConnection(socket, socket, { message: received, failed });
async function grant(threadId) {
  const options = { socketPath: '/run/codex/control.sock', path: '/grant', method: 'POST' };
  function send(resolve, reject) {
    function received(response) {
      response.resume();
      response.on('end', resolve);
    }
    const outgoing = request(options, received);
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ thread: threadId, computer: 'fixture-computer',
      token: 'fixture-turn', expires: Date.now() + 120_000 }));
  }
  await new Promise(send);
}
try {
  await once(socket, 'connect');
  await connection.rpc('initialize', { clientInfo: { name: 'capabilities', version: '1' },
    capabilities: { experimentalApi: true } });
  connection.notify('initialized', {});
  const result = await connection.rpc('thread/start', { model: 'gpt-6.1-sol',
    approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, environments: [] });
  await grant(result.thread.id);
  await connection.rpc('turn/start', { threadId: result.thread.id,
    input: [{ type: 'text', text: 'Reply using the local fixture.', text_elements: [] }] });
  function completed(message) {
    return message.method === 'turn/completed';
  }
  const deadline = Date.now() + 20_000;
  while (!notifications.some(completed) && Date.now() < deadline) {
    await delay(25);
  }
  const outcome = notifications.find(completed);
  assert.equal(outcome?.params.turn.status, 'completed', JSON.stringify(notifications));
  assert.equal(requests, 1);
  assert.ok(JSON.stringify(notifications).includes(reply));
  process.stdout.write('PASS private turn with template capabilities\n');
} finally {
  socket.destroy();
  provider.closeAllConnections();
  provider.close();
}
