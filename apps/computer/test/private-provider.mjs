import { createServer } from 'node:http';
const requests = [];
const held = new Map();
let canaries = {};
let nextResponse = 0;
async function body(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
function emit(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
function complete(response, id) {
  emit(response, { type: 'response.completed', response: { id, status: 'completed',
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  response.end();
}
function message(response, id, text) {
  const item = { id: `msg_${id}`, type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text }] };
  emit(response, { type: 'response.output_item.added', output_index: 0,
    item: { ...item, content: [] } });
  emit(response, { type: 'response.output_text.delta', item_id: item.id,
    output_index: 0, content_index: 0, delta: text });
  function finishMessage() {
    emit(response, { type: 'response.output_item.done', output_index: 0, item });
    complete(response, id);
  }
  return finishMessage;
}
function isOutput(item) {
  return ['function_call_output', 'custom_tool_call_output'].includes(item.type);
}
function serveModel(request, response, input) {
  const text = JSON.stringify(input.input);
  const marker = /P414:(\w+)/u.exec(text)?.[1] ?? 'plain';
  requests.push({ body: input, thread: request.headers['session-id'], marker });
  const id = `resp_${++nextResponse}`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  emit(response, { type: 'response.created', response: { id } });
  const outputs = input.input?.some(isOutput);
  if (['exec_command', 'apply_patch', 'exec', 'request_user_input'].includes(marker) && !outputs) {
    let item;
    if (marker === 'exec') {
      item = { id: `tool_${id}`, type: 'custom_tool_call', name: 'exec', call_id: `call_${id}`,
        input: `text(await tools.exec_command({cmd: "echo ${canaries.tool} > /tmp/private-tool-file"}))` };
    } else if (marker === 'apply_patch') {
      item = { id: `tool_${id}`, type: 'custom_tool_call', name: marker, call_id: `call_${id}`,
        input: `*** Begin Patch\n*** Add File: /tmp/private-tool-file\n+${canaries.tool}\n*** End Patch` };
    } else {
      const args = marker === 'exec_command'
        ? { cmd: `echo ${canaries.tool} > /tmp/private-tool-file` }
        : { questions: [{ id: 'private', header: 'private', question: canaries.tool,
              options: [{ label: 'Continue', description: 'Continue' }] }] };
      item = { id: `tool_${id}`, type: 'function_call', name: marker, call_id: `call_${id}`,
        arguments: JSON.stringify(args) };
    }
    emit(response, { type: 'response.output_item.done', output_index: 0, item });
    complete(response, id);
    return;
  }
  if (marker === 'reasoning') {
    const item = { id: `reason_${id}`, type: 'reasoning', summary: [
        { type: 'summary_text', text: canaries.reasoning }
      ] };
    emit(response, { type: 'response.output_item.added', output_index: 0,
      item: { ...item, summary: [] } });
    emit(response, { type: 'response.reasoning_summary_text.delta', item_id: item.id,
      output_index: 0, summary_index: 0, delta: canaries.reasoning });
    emit(response, { type: 'response.output_item.done', output_index: 0, item });
  }
  let reply = canaries.reply;
  if (text.includes('P414_MEMORY_FREE')) {
    reply = 'Memory-free fixture reply.';
  } else if (marker === 'compact') {
    reply = canaries.compaction;
  }
  const finish = message(response, id, reply);
  if (marker.startsWith('held')) {
    held.set(id, finish);
    function closed() {
      held.delete(id);
    }
    response.on('close', closed);
    return;
  }
  finish();
}
async function handle(request, response) {
  try {
    if (request.url === '/requests') {
      json(response, requests);
      return;
    }
    const input = await body(request);
    if (request.url === '/setup') {
      canaries = input;
      json(response, {});
      return;
    }
    if (request.url === '/release') {
      for (const finish of held.values()) {
        finish();
      }
      held.clear();
      json(response, {});
      return;
    }
    if (request.url !== '/v1/responses') {
      response.writeHead(404);
      response.end();
      return;
    }
    serveModel(request, response, input);
  } catch {
    response.writeHead(500);
    response.end();
  }
}
function received(request, response) {
  void handle(request, response);
}
createServer(received).listen(3000, '0.0.0.0');
