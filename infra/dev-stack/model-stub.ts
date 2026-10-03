// Dev-stack qualification only: this process never contacts an external provider.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/approval-calls') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(calls)); return;
  }
  if (req.method === 'POST' && req.url === '/mcp/approval-journey/installed') {
    void (async () => {
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 1_048_576) { res.writeHead(413); res.end(); return; }
      }
      calls.push({ body, requestId: String(req.headers['x-request-id']) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
    })().catch(() => res.destroy());
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
  req.on('end', () => { void (async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input?: Array<{ type?: string; role?: string; content?: unknown; output?: string }> };
    const input = body.input ?? [];
    const user = input.findLastIndex(item => item.type === 'message' && item.role === 'user');
    const prompt = JSON.stringify(input[user]?.content ?? '');
    const pdf = prompt.includes('UPLOAD_PDF_PROOF');
    const output = input.slice(user+1).filter(item => item.type === 'function_call_output').map(item => item.output ?? '').join('\n');
    const customOutput = input.slice(user+1).some(item => item.type === 'custom_tool_call_output');
    const path = /\/workspace\/uploads\/[\w/-]+\/project\.pdf\.md/u.exec(prompt)?.[0];
    const answer = pdf ? (output.includes('Project code: Willow-47.') ? 'The project code is Willow-47.' : 'PDF reading failed.') : 'Hello from your computer.';
    const stopped = new AbortController();
    res.once('close', () => stopped.abort());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `resp_${randomUUID()}`, message = `msg_${randomUUID()}`;
    const emit = (event: { type: string; [name: string]: unknown }) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'response.created', response: { id } });
    if (pdf && path && !output && !customOutput) {
      // Exercise the routed model's custom-call history before its shell fallback.
      emit({ type: 'response.output_item.done', item: { type: 'custom_tool_call', id: `ct_${randomUUID()}`, status: 'completed', name: 'exec', call_id: `call_${randomUUID()}`, input: `text(await tools.exec_command({cmd: "cat ${path}"}))` } });
    } else if (pdf && path && !output) {
      emit({ type: 'response.output_item.done', item: { type: 'reasoning', id: `rs_${randomUUID()}`, summary: [], encrypted_content: 'stub-continuation-state' } });
      emit({ type: 'response.output_item.done', item: { type: 'function_call', name: 'exec_command', call_id: `call_${randomUUID()}`, arguments: JSON.stringify({ cmd: `cat ${path}`, max_output_tokens: 1000 }) } });
    } else {
    emit({ type: 'response.output_item.added', item: { id: message, type: 'message', role: 'assistant', content: [] } });
    for (const delta of pdf ? [answer] : ['Hello ', 'from your ', 'computer.']) { emit({ type: 'response.output_text.delta', delta }); await delay(delta === 'Hello ' && prompt.includes('Say hello again.') ? 30_000 : 500, undefined, { signal: stopped.signal }); }
    emit({ type: 'response.output_item.done', item: { id: message, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } });
    }
    emit({ type: 'response.completed', response: { id, status: 'completed', model: 'gpt-6-luna', usage: { input_tokens: 1000, output_tokens: 120, total_tokens: 1120 } } });
    res.end();
  })().catch(() => res.destroy()); });
});
server.listen(Number(process.env['MODEL_STUB_PORT'] ?? process.env['STUB_PORT'] ?? 43003), '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') console.log(`Stub ready ${address.port}`); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
