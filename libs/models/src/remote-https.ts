// Adapted from OpenCrane 1 commit 10abd0ef6182f36bec13d8f1358e43b15ead7cd5.
import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import type { IncomingMessage, ClientRequest, OutgoingHttpHeaders } from 'node:http';
import { isPublicAddress, remoteEndpoint } from './address-policy.ts';

export interface RemoteNetwork {
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  request?: (url: URL, options: RequestOptions,
    callback: (response: IncomingMessage) => void) => ClientRequest;
  deadlineMs?: number;
}
export async function prepareRemote(locator: string, network: RemoteNetwork, signal: AbortSignal) {
  const endpoint = remoteEndpoint(locator);
  const addresses = await resolveAddresses(endpoint.hostname, network, signal);
  signal.throwIfAborted();
  function unsafe(address: { address: string; family: number }) {
    return !isPublicAddress(address);
  }
  if (!addresses.length || addresses.some(unsafe)) throw new Error('unsafe_address');
  return { endpoint, address: addresses[0]! };
}

export function exchangeRemote(target: Awaited<ReturnType<typeof prepareRemote>>, raw: string,
  headers: OutgoingHttpHeaders, network: RemoteNetwork, signal: AbortSignal, limit: number) {
  const { endpoint, address } = target;
  function pinned(_host: string, _options: unknown,
    done: (error: Error | null, address: string, family: number) => void) {
    done(null, address.address, address.family);
  }
  const options: RequestOptions = { method: 'POST', agent: false, signal,
    family: address.family, servername: endpoint.hostname, rejectUnauthorized: true,
    lookup: pinned, headers };
  function exchange(resolve: (reply: { data: Buffer; contentType: string }) => void,
    reject: (error: Error) => void) {
    function failed() { reject(new Error('network_refused')); }
    function receive(res: IncomingMessage) {
      function refuse(code: string) { res.destroy(); reject(new Error(code)); }
      if (res.statusCode === 401 || res.statusCode === 403) return refuse('connection_required');
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        return refuse('redirect_refused');
      }
      const contentType = res.headers['content-type'] ?? '';
      if (res.statusCode !== 200 || res.headers['mcp-session-id'] !== undefined ||
          !/^application\/json(?:;|$)/iu.test(contentType)) return refuse('protocol_refused');
      let bytes = 0;
      const chunks: Buffer[] = [];
      function collect(chunk: Buffer) {
        bytes += chunk.length;
        if (bytes > limit) { refuse('response_limit'); return; }
        chunks.push(chunk);
      }
      function finished() { resolve({ data: Buffer.concat(chunks), contentType }); }
      res.on('data', collect);
      res.once('end', finished);
      res.once('error', failed);
    }
    const req = (network.request ?? request)(endpoint, options, receive);
    req.removeHeader('connection');
    req.once('error', failed);
    req.end(raw);
  }
  return new Promise<{ data: Buffer; contentType: string }>(exchange);
}

async function resolveAddresses(hostname: string, network: RemoteNetwork, signal: AbortSignal) {
  let abort = () => {};
  function resolvePublic(host: string) { return lookup(host, { all: true }); }
  function cancelled(_resolve: (value: never) => void, reject: (error: Error) => void) {
    abort = function timedOut() { reject(new Error('discovery_timeout')); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  try {
    const resolution = (network.resolve ?? resolvePublic)(hostname);
    return await Promise.race([resolution, new Promise<never>(cancelled)]);
  } finally { signal.removeEventListener('abort', abort); }
}
