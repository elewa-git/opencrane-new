import { randomUUID } from 'node:crypto';
import { losslessJson, prepareRemote, exchangeRemote, type RemoteNetwork } from '@opencrane/models';
import { z } from 'zod';
export type { RemoteNetwork } from '@opencrane/models';

export const version = '2026-07-28';
const rpcResult = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.record(z.string(), z.unknown()) }).strict();

/** Use the saved endpoint, without caller headers, credentials, sessions or redirects. */
export async function remoteRequest(locator: string, method: 'server/discover' | 'tools/list', cursor: string | undefined,
  network: RemoteNetwork, signal: AbortSignal) {
  const id = randomUUID();
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...(cursor ? { cursor } : {}),
    _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } });
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('request_limit');
  const target = await prepareRemote(locator, network, signal);
  const headers = { 'content-type': 'application/json', accept: 'application/json',
    'mcp-protocol-version': version, 'mcp-method': method };
  const reply = await exchangeRemote(target, body, headers, network, signal, 4 * 1024 * 1024);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(reply.data);
    const parsed = losslessJson(text); // Reject duplicate keys and excessive nesting before ordinary parsing.
    const result = rpcResult.parse(JSON.parse(text));
    if (result.id !== id) throw new Error('protocol_refused');
    if (!(parsed.value instanceof Map)) throw new Error('protocol_refused');
    return { resultJson: parsed.value.get('result')!.canonical };
  } catch { throw new Error('protocol_refused'); }
}
