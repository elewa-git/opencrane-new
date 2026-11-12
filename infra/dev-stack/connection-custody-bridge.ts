import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

/** Reach the same private Kubernetes proxy from the host and the models container. */
export async function startConnectionCustodyBridge(socketPath: string, port: number) {
  function forward(incoming: IncomingMessage, response: ServerResponse) {
    const options = { socketPath, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: '127.0.0.1' } };
    function receive(upstream: IncomingMessage) {
      response.writeHead(upstream.statusCode ?? 503, upstream.headers);
      upstream.pipe(response);
    }
    const outgoing = request(options, receive);
    function failed() {
      outgoing.destroy();
      if (!response.headersSent) response.writeHead(503);
      response.end();
    }
    outgoing.on('error', failed);
    incoming.on('error', failed);
    incoming.pipe(outgoing);
  }
  const server = createServer(forward);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  function close() {
    server.closeAllConnections();
    server.close();
  }
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return close;
}
