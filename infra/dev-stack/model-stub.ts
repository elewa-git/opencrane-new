// Dev-stack qualification only: this process never contacts an external provider.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
const calls: Array<{ body: string; requestId: string }> = [];
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
  if (process.env['MODEL_STUB_PAUSE_ON_STOP'] !== '1') req.resume();
  if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
  void (async () => {
    let body = '';
    if (process.env['MODEL_STUB_PAUSE_ON_STOP'] === '1') {
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 1_048_576) { res.writeHead(413); res.end(); return; }
      }
    }
    const input = body ? z.object({ input: z.union([z.string(), z.array(z.object({
      role: z.string().optional(), content: z.unknown().optional(),
    }))]) }).parse(JSON.parse(body)).input : '';
    const currentPrompt = typeof input === 'string' ? input : JSON.stringify(input.findLast(item => item.role === 'user')?.content ?? '');
    const pauseOnStop = currentPrompt.includes('Say hello again.');
    const stopped = new AbortController();
    res.once('close', () => stopped.abort());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `resp_${randomUUID()}`, message = `msg_${randomUUID()}`;
    const emit = (event: { type: string; [name: string]: unknown }) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'response.created', response: { id } });
    emit({ type: 'response.output_item.added', item: { id: message, type: 'message', role: 'assistant', content: [] } });
    for (const delta of ['Hello ', 'from your ', 'computer.']) {
      emit({ type: 'response.output_text.delta', delta });
      // This journey prompt exercises Stop against a still-streaming provider.
      const pause = delta === 'Hello ' && pauseOnStop;
      await delay(pause ? 30_000 : 500, undefined, { signal: stopped.signal });
    }
    emit({ type: 'response.output_item.done', item: { id: message, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from your computer.' }] } });
    emit({ type: 'response.completed', response: { id, status: 'completed', model: 'gpt-6-luna', usage: { input_tokens: 1000, output_tokens: 120, total_tokens: 1120 } } });
    res.end();
  })().catch(() => res.destroy());
});
server.listen(Number(process.env['MODEL_STUB_PORT'] ?? 43003), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
