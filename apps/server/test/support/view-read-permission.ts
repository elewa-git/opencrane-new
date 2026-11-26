import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';

const check = z.object({ tuple_key: z.object({ object: z.string(), relation: z.string() }) });

export async function holdOpenFgaReply(apiUrl: string, object: string, relation: string) {
  const observed = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let held = 0;

  async function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const part of incoming) {
      chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
    }
    const body = Buffer.concat(chunks);
    let hold = false;
    if (incoming.url?.endsWith('/check')) {
      const query = check.safeParse(JSON.parse(body.toString()));
      hold = query.success && query.data.tuple_key.object === object &&
        query.data.tuple_key.relation === relation;
    }
    async function relay(response: IncomingMessage) {
      if (hold && response.statusCode === 200) {
        held++;
        if (held === 2) observed.resolve();
        await released.promise;
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    }
    function respond(response: IncomingMessage) {
      void relay(response);
    }
    const upstream = request(`${apiUrl}${incoming.url}`,
      { method: incoming.method, headers: incoming.headers }, respond);
    upstream.on('error', function failed() {
      outgoing.writeHead(502);
      outgoing.end();
    });
    upstream.end(body);
  }

  function handle(incoming: IncomingMessage, outgoing: ServerResponse) {
    function fail(error: unknown) {
      observed.reject(error);
      outgoing.writeHead(502);
      outgoing.end();
    }
    void forward(incoming, outgoing).catch(fail);
  }
  const proxy = createServer(handle);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing OpenFGA proxy port');
  async function close() {
    released.resolve();
    const closed = once(proxy, 'close');
    proxy.close();
    proxy.closeAllConnections();
    await closed;
  }
  return { apiUrl: `http://127.0.0.1:${address.port}`, observed: observed.promise,
    release: released.resolve, close };
}
