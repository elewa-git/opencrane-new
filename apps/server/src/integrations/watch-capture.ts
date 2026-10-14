import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { losslessJson, mcpDispatchRouteSchema } from '@opencrane/models';
import type { z } from 'zod';
import { discoverInventory } from './inventory.ts';
import { version } from './remote.ts';

type Route = z.infer<typeof mcpDispatchRouteSchema>;

// Use the operator's dispatch destination. Never accept a URL from a tool definition.
export async function captureDispatchCatalogue(route: Route, signal: AbortSignal) {
  async function call(method: 'server/discover' | 'tools/list', cursor?: string) {
    const destination = new URL(`http://${route.upstream}`);
    destination.pathname = `/mcp/${route.serverId}/${route.connectionId}`;
    const id = randomUUID();
    const metadata = { 'io.modelcontextprotocol/protocolVersion': version,
      'io.modelcontextprotocol/clientCapabilities': {} };
    const params = { _meta: metadata, ...(cursor ? { cursor } : {}) };
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const headers = { 'content-type': 'application/json', accept: 'application/json',
      'mcp-protocol-version': version, 'mcp-method': method,
      'x-opencrane-mcp-generation': route.generation ?? '' };
    const options = { method: 'POST', headers, signal, agent: false as const };
    const reply = await new Promise<string>(receive);
    const parsed = losslessJson(reply);
    if (!(parsed.value instanceof Map) || parsed.value.get('jsonrpc')?.value !== '2.0' ||
        parsed.value.get('id')?.value !== id || !parsed.value.has('result') ||
        parsed.value.has('error')) throw new Error('Catalogue response refused');
    return parsed.value.get('result')!.canonical;

    function receive(resolve: (value: string) => void, reject: (error: Error) => void) {
      function response(res: IncomingMessage) {
        function refuse() {
          res.destroy();
          reject(new Error('Catalogue response refused'));
        }
        if (res.statusCode !== 200 || res.headers['mcp-session-id'] ||
            !/^application\/json(?:;|$)/iu.test(res.headers['content-type'] ?? '')) {
          refuse();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        function chunk(value: Buffer) {
          bytes += value.length;
          if (bytes > 4 * 1024 * 1024) {
            refuse();
            return;
          }
          chunks.push(value);
        }
        function finished() {
          try {
            resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            refuse();
          }
        }
        res.on('data', chunk);
        res.once('end', finished);
        res.once('error', refuse);
      }
      const upstream = request(destination, options, response);
      upstream.once('error', reject);
      upstream.end(body);
    }
  }
  const inventory = await discoverInventory(call);
  return { ...inventory, serverId: route.serverId, connectionId: route.connectionId,
    accountMode: 'none' as const };
}
