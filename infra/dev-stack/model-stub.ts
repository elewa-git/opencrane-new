// Dev-stack qualification only: this process never contacts an external provider.
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stageBModelCall } from './stage-b-model.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const approvalRevision = process.env['MODEL_STUB_MCP_REVISION'];
if (!approvalRevision) throw new Error('Approval stub revision is missing');
const approvalGeneration = process.env['MODEL_STUB_MCP_GENERATION'];
if (!approvalGeneration) throw new Error('Approval stub generation is missing');
const calls: Array<{ body: string; requestId: string }> = [];
let modelRequests = 0;
const providerCounts = { managed: 0, other: 0 };
function countProviderRequest(authorization: string | undefined) {
  const file = process.env['MODEL_STUB_MANAGED_FILE'];
  let value: string | undefined;
  try {
    if (file) value = readFileSync(file, 'utf8');
  } catch {
    // Allow the stub to start before setup saves its credential.
  }
  if (value && authorization === `Bearer ${value}`) {
    providerCounts.managed++;
  } else {
    providerCounts.other++;
  }
}
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/provider-counts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(providerCounts));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    countProviderRequest(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/journey-counts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ modelRequests }));
    return;
  }
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
      // Check both headers immediately before recording the effect, without another asynchronous step.
      if (req.headers['x-opencrane-mcp-revision'] !== approvalRevision ||
          req.headers['x-opencrane-mcp-generation'] !== approvalGeneration) {
        res.writeHead(409);
        res.end('{"error":"Approval stub revision or generation changed"}');
        return;
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
    modelRequests += 1;
    countProviderRequest(req.headers.authorization);
    if (process.env['MODEL_STUB_CAPTURE']) appendFileSync(process.env['MODEL_STUB_CAPTURE'], Buffer.concat(chunks).toString() + '\n', { mode: 0o600 });
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean; input?: Array<{ type?: string; role?: string; content?: unknown; output?: unknown }> };
    if (body.stream === false) {
      const content = [{ type: 'output_text', text: 'OK' }];
      const output = [{ type: 'message', role: 'assistant', content }];
      const usage = { input_tokens: 10, output_tokens: 1, total_tokens: 11 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', output, usage }));
      return;
    }
    const input = body.input ?? [];
    const user = input.findLastIndex(item => item.type === 'message' && item.role === 'user');
    const prompt = JSON.stringify(input[user]?.content ?? '');
    const pdf = prompt.includes('UPLOAD_PDF_PROOF') || prompt.includes('What is the project code in the attached PDF?');
    const output = input.slice(user+1).filter(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type ?? '')).map(item => typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')).join('\n');
    const customOutput = input.slice(user+1).some(item => item.type === 'custom_tool_call_output');
    const path = /\/workspace\/uploads\/[\w/-]+\/project\.pdf\.md/u.exec(prompt)?.[0];
    const inline = !prompt.includes('UPLOAD_PDF_PROOF') && prompt.includes('Untrusted document content') ? prompt : '';
    const code = /Project code: ([\w-]+)\./u.exec(output || inline)?.[1];
    const answer = pdf ? (code ? `The project code is ${code}.` : 'PDF reading failed.') : 'Hello from your computer.';
    const stopped = new AbortController();
    res.once('close', () => stopped.abort());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `resp_${randomUUID()}`, message = `msg_${randomUUID()}`;
    const emit = (event: { type: string; [name: string]: unknown }) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'response.created', response: { id } });
    let demoCall: ReturnType<typeof stageBModelCall>;
    if (prompt.includes('STAGE_B_READ') || prompt.includes('STAGE_B_WRITE')) {
      demoCall = stageBModelCall(body);
    }
    if (demoCall) {
      emit({ type: 'response.output_item.done', item: demoCall });
    } else if (pdf && !code && path && !output && !customOutput) {
      // Read the file when inline text is empty, unavailable or missing the requested fact.
      // Match the real Sol call. A disabled host must fail, with no invented shell fallback.
      emit({ type: 'response.output_item.done', item: { type: 'custom_tool_call', id: `ct_${randomUUID()}`, status: 'completed', name: 'exec', call_id: `call_${randomUUID()}`, input: `text(await tools.exec_command({cmd: "cat ${path}", max_output_tokens: 1000}))` } });
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
