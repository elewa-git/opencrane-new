// Adapted from OC1 mcp-remote-client-https.ts, commit 10abd0ef6182f36bec13d8f1358e43b15ead7cd5.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { losslessJson } from '@opencrane/models';
import { z } from 'zod';
import { isPublicAddress, remoteEndpoint } from './address-policy.ts';

export const version = '2026-07-28';
export interface RemoteNetwork {
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  request?: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  deadlineMs?: number;
}
const rpcResult = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.record(z.string(), z.unknown()) }).strict();

/** The caller selects the stored endpoint. No caller headers, credentials, sessions or redirects pass. */
export async function remoteRequest(locator: string, method: 'server/discover' | 'tools/list', cursor: string | undefined,
  network: RemoteNetwork, signal: AbortSignal) {
  const id = randomUUID();
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...(cursor ? { cursor } : {}),
    _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } });
  const text = await remoteForward(locator, body, method, undefined, network, signal);
  try {
    const parsed = losslessJson(text); // Reject duplicate keys and excessive nesting before ordinary parsing.
    const result = rpcResult.parse(JSON.parse(text));
    if (result.id !== id) throw new Error('protocol_refused');
    if (!(parsed.value instanceof Map)) throw new Error('protocol_refused');
    return { resultJson: parsed.value.get('result')!.canonical };
  } catch { throw new Error('protocol_refused'); }
}

async function resolveAddresses(hostname: string, network: RemoteNetwork, signal: AbortSignal) {
  let abort = () => {};
  try {
    return await Promise.race([
      (network.resolve ?? (host => lookup(host, { all: true })))(hostname),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('discovery_timeout'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** Every socket, including published calls, pins a freshly checked DNS answer through TLS. */
export async function remoteForward(locator: string, body: string, method: string, tool: string | undefined, network: RemoteNetwork, signal: AbortSignal, beforeConnect?: () => Promise<void>, parameterHeaders: Record<string, string> = {}) {
  const endpoint = remoteEndpoint(locator);
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('request_limit');
  const addresses = await resolveAddresses(endpoint.hostname, network, signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !isPublicAddress(a))) throw new Error('unsafe_address');
  await beforeConnect?.();
  signal.throwIfAborted();
  const address = addresses[0]!;
  const options: RequestOptions = { method: 'POST', agent: false, signal, family: address.family,
    servername: endpoint.hostname, rejectUnauthorized: true,
    lookup: (_host, _options, done) => done(null, address.address, address.family),
    headers: { ...parameterHeaders, 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': version, 'mcp-method': method, ...(tool ? { 'mcp-name': tool } : {}) } };
  const text = await new Promise<string>((resolve, reject) => {
    const req = (network.request ?? request)(endpoint, options, res => {
      const refuse = (code: string) => { res.destroy(); reject(new Error(code)); };
      if (res.statusCode === 401 || res.statusCode === 403) return refuse('connection_required');
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) return refuse('redirect_refused');
      if (res.statusCode !== 200 || res.headers['mcp-session-id'] || !/^application\/json(?:;|$)/iu.test(res.headers['content-type'] ?? '')) return refuse('protocol_refused');
      let bytes = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { refuse('response_limit'); return; }
        chunks.push(chunk);
      });
      res.once('end', () => {
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { reject(new Error('protocol_refused')); }
      });
      res.once('error', () => reject(new Error('network_refused')));
    });
    req.once('error', () => reject(new Error('network_refused')));
    req.end(body);
  });
  losslessJson(text);
  return text;
}
