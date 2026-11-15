import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { Client } from 'minio';
import { storageTransport } from '../infra/package/object-credentials.mjs';

it('aborts a stalled object response before a maintenance window can reach a hard kill',
  async function abortsObjectRead() {
    const connected = Promise.withResolvers();
    function stalled(_request, response) {
      response.writeHead(200, { 'Content-Length': '12', 'Content-Type': 'application/octet-stream' });
      response.write('one');
      connected.resolve();
    }
    const server = createServer(stalled);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const controller = new AbortController();
    const client = new Client({ endPoint: '127.0.0.1', port: server.address().port,
      useSSL: false, region: 'us-east-1', accessKey: 'test', secretKey: 'test-secret',
      transport: storageTransport('http:', controller.signal),
      retryOptions: { disableRetry: true } });
    async function readObject() {
      const stream = await client.getObject('files', 'one');
      for await (const _chunk of stream) { /* Wait for the stalled response body. */ }
    }
    try {
      const read = readObject();
      const rejected = expect(read).rejects.toThrow();
      await connected.promise;
      controller.abort();
      await rejected;
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });
