import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { mcpHeaders, currentPublication, readToolPolicy, losslessJson } from '@opencrane/models';
import { remoteForward, type RemoteNetwork } from './remote.ts';

/** Loopback-only companion to agentgateway; only a fresh, one-use decision permit can open a socket. */
export async function guardedMcp(store: EventStore, silo: string,
  takePermit: (token: string, serverId: string, digest: string, bodyDigest: string) => Promise<boolean>, network: RemoteNetwork = {}) {
  const server = createServer((req, res) => {
    void (async () => {
      const match = /^\/mcp\/([\w-]+)\/([\w-]+)$/u.exec(req.url ?? '');
      if (!match || req.method !== 'POST') throw new Error('Refused');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk) || (bytes += chunk.length) > 1_048_576) throw new Error('Refused');
        chunks.push(chunk);
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const digest = losslessJson(body).digest;
      const publication = await currentPublication(store, silo, match[1]!);
      const policy = await readToolPolicy(store, silo, match[1]!);
      if (!publication || !policy.published || policy.connectionId !== match[2] || publication.desired.accountMode !== 'none') throw new Error('Refused');
      const call = z.object({ method: z.enum(['server/discover', 'tools/list', 'tools/call']), params: z.object({ name: z.string().optional() }) }).parse(JSON.parse(body));
      const response = await remoteForward(publication.desired.target, body, call.method, call.params.name, network, AbortSignal.timeout(network.deadlineMs ?? 30_000), async () => {
        if (!await takePermit(String(req.headers['x-mcp-permit'] ?? ''), match[1]!, publication.digest, digest)) throw new Error('Refused');
      }, mcpHeaders(publication, body));
      res.setHeader('content-type', 'application/json'); res.end(response);
    })().catch(() => { res.writeHead(502); res.end('{"error":"MCP transport refused"}'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Transport unavailable');
  return { host: `127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
