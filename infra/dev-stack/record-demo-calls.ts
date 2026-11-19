import { appendFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Keep synthetic writes for the journey's byte and dispatch-count assertions. */
export function recordDemoCalls(demo: FastifyInstance, file: string) {
  writeFileSync(file, '', { mode: 0o600 });
  demo.addHook('onRequest', recordRequest);

  function recordRequest(request: FastifyRequest, _reply: FastifyReply, done: () => void) {
    if (request.headers['mcp-name'] === 'change_delivery_slot') {
      const chunks: Buffer[] = [];
      function received(chunk: Buffer) {
        chunks.push(chunk);
      }
      function finished() {
        const body = Buffer.concat(chunks).toString();
        const requestId = String(request.headers['x-request-id']);
        const record = { body, requestId };
        appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      }
      request.raw.on('data', received);
      request.raw.once('end', finished);
    }
    done();
  }
}
