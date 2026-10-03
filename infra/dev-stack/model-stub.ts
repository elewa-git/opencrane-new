// Dev-stack qualification only: this process never contacts an external provider.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const server = createServer((req, res) => {
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
      const pause = delta === 'Hello ' && body.includes('Say hello again.');
      await delay(pause ? 30_000 : 500, undefined, { signal: stopped.signal });
    }
    emit({ type: 'response.output_item.done', item: { id: message, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from your computer.' }] } });
    emit({ type: 'response.completed', response: { id, status: 'completed', model: 'gpt-6-luna', usage: { input_tokens: 1000, output_tokens: 120, total_tokens: 1120 } } });
    res.end();
  })().catch(() => res.destroy());
});
server.listen(Number(process.env['MODEL_STUB_PORT'] ?? 43003), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
