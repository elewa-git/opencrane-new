import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { captureDispatchCatalogue } from '../src/integrations/watch-capture.ts';

const metadata = { resultType: 'complete', ttlMs: 60_000, cacheScope: 'public' };
const tool = { name: 'read', description: '<script>untrusted text</script>',
  inputSchema: { type: 'object' } };
const modes = ['complete', 'pages', 'response size', 'tool size', 'stalled', 'redirect'] as const;
async function captures(mode: typeof modes[number]) {
  const calls: string[] = [];
  const controller = new AbortController();
  function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    function chunk(value: Buffer) {
      chunks.push(value);
    }
    function respond() {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      const body = z.object({ id: z.string(), method: z.string() }).parse(parsed);
      calls.push(body.method);
      expect(req.url).toBe('/mcp/fixture/installed');
      expect(req.headers['x-opencrane-mcp-generation']).toBe('instance-1');
      expect(req.headers['authorization']).toBeUndefined();
      if (mode === 'stalled') {
        controller.abort();
        return;
      }
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1' });
        res.end();
        return;
      }
      let result: unknown;
      if (body.method === 'server/discover') {
        result = { ...metadata, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
      } else {
        let declaration = tool;
        if (mode === 'tool size') {
          declaration = { ...tool, inputSchema: { type: 'object' },
            description: 'x'.repeat(40_000) };
        }
        result = { ...metadata, tools: [declaration] };
        if (mode === 'pages') {
          result = { ...metadata, tools: [], nextCursor: String(calls.length) };
        }
      }
      if (mode === 'response size') result = 'x'.repeat(4 * 1024 * 1024);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    }
    req.on('data', chunk);
    req.once('end', respond);
  }
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const route = { serverId: 'fixture', connectionId: 'installed',
    upstream: `127.0.0.1:${address.port}`, generation: 'instance-1' };
  try {
    const capture = captureDispatchCatalogue(route, controller.signal);
    if (mode === 'complete') {
      const catalogue = await capture;
      expect(catalogue.tools[0]?.definition).toContain('<script>untrusted text</script>');
      expect(catalogue.tools[0]?.reviewed).toBe(false);
      expect(Date.parse(catalogue.expiresAt) - Date.parse(catalogue.checkedAt)).toBe(60_000);
      expect(calls).toEqual(['server/discover', 'tools/list']);
    } else {
      await expect(capture).rejects.toThrow();
      if (mode === 'pages') expect(calls).toHaveLength(11);
      expect(calls).not.toContain('tools/call');
    }
  } finally {
    controller.abort();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}
it.each(modes)('captures the configured upstream with bounded %s responses', captures);
