// Dev-stack qualification only: this process never contacts an external provider.
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  req.resume();
  if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {
    id: 'resp_dev_stub', object: 'response', status: 'completed', model: 'gpt-5-nano', output: [],
    usage: { input_tokens: 1000, output_tokens: 120, total_tokens: 1120 },
  } })}\n\n`);
});
server.listen(43003, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
