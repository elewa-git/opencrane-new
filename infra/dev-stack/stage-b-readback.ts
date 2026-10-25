import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { createStageBCollector } from './stage-b-collector.ts';

const quoteSchema = z.strictObject({
  quoteId: z.literal('DEMO-001'), amountCents: z.literal(12500),
  slot: z.enum(['morning', 'afternoon']), effectCount: z.int().nonnegative(),
});
const replySchema = z.object({ result: z.object({ structuredContent: quoteSchema }) });

export async function readStageBQuote(collector: ReturnType<typeof createStageBCollector>,
  socketPath: string, revision: string, label: string) {
  const payload = {
    jsonrpc: '2.0', id: `readback-${label}`, method: 'tools/call',
    params: { name: 'read_fixture_quote', arguments: { quoteId: 'DEMO-001' },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  };
  const headers = {
    'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call', 'mcp-name': 'read_fixture_quote',
    'x-opencrane-mcp-revision': revision,
  };
  const options = { socketPath, path: '/', method: 'POST', headers, timeout: 15000 };
  const received = await new Promise<{ status: number | undefined; body: string }>(exchange);
  const at = new Date().toISOString();
  const original = { at, ...received };
  collector.record(`${label}Response`, original);
  assert.equal(received.status, 200);
  const body: unknown = JSON.parse(received.body);
  const parsed = replySchema.parse(body);
  const readback = { at, value: parsed.result.structuredContent };
  return collector.record(label, readback);

  function exchange(resolve: (value: { status: number | undefined; body: string }) => void,
    reject: (error: Error) => void) {
    function received(response: IncomingMessage) {
      const chunks: Buffer[] = [];
      function chunk(data: Buffer) {
        chunks.push(data);
      }
      function finished() {
        const buffer = Buffer.concat(chunks);
        const body = buffer.toString();
        const result = { status: response.statusCode, body };
        resolve(result);
      }
      response.on('data', chunk);
      response.on('error', reject);
      response.on('end', finished);
    }
    const outgoing = request(options, received);
    function timedOut() {
      outgoing.destroy(new Error('Demo readback timed out'));
    }
    outgoing.on('timeout', timedOut);
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify(payload));
  }
}
