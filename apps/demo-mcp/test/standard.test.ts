import { expect, it } from 'vitest';
import { createDemoServer } from '../src/server.ts';
import { catalogue } from '../src/tools.ts';
import { losslessJson } from '@opencrane/events/lossless-json';

async function offersStandardCatalogue() {
  const original = 'e58b2ca2a63ecb77f6c028056e36c67ffddcdbecefa30ae0b16dc44990ec17da';
  const server = createDemoServer(undefined, {});
  try {
    async function call(method: string, params = {}) {
      const reply = await server.inject({ method: 'POST', url: '/',
        headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
          'mcp-name': method === 'tools/call' ? 'read_fixture_quote' : '' },
        payload: { jsonrpc: '2.0', id: 1, method, params } });
      return reply.json<unknown>();
    }
    const discovery = await call('server/discover');
    expect(discovery).toHaveProperty('result.capabilities.tools');
    expect(JSON.stringify(discovery)).not.toContain('io.opencrane');
    const tools = await call('tools/list');
    expect(tools).toHaveProperty('result.tools');
    expect(JSON.stringify(tools)).not.toContain('io.opencrane');
    const result = await call('tools/call', { name: 'read_fixture_quote',
      arguments: { quoteId: 'DEMO-001' } });
    expect(result).toMatchObject({ result: { isError: false,
      structuredContent: { quoteId: 'DEMO-001', amountCents: 12500 } } });
    expect(losslessJson(JSON.stringify(catalogue)).digest).toBe(original);
  } finally {
    await server.close();
  }
}
it('offers a standard catalogue without OpenCrane declarations or revision checks', offersStandardCatalogue);
