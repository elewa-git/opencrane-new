import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { egressDestinationSchema } from '@opencrane/events';
import { isPublicAddress } from './address-policy.ts';
import { readEgressHello } from './egress-client-hello.ts';

type Transport = {
  resolve: (host: string) => Promise<LookupAddress[]>;
  connect: (address: string, port: number) => Socket;
};
function resolveAll(host: string) {
  return lookup(host, { all: true, verbatim: true });
}
function connectAddress(address: string, port: number) {
  return connect({ host: address, port });
}
const systemTransport: Transport = { resolve: resolveAll, connect: connectAddress };

async function bounded<T>(work: Promise<T>, signal: AbortSignal) {
  let abort: (() => void) | undefined;
  function cancelled(_resolve: (value: never) => void, reject: (error: Error) => void) {
    function refuse() {
      reject(new Error('egress_dns_refused'));
    }
    abort = refuse;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  }
  try {
    return await Promise.race([work, new Promise<never>(cancelled)]);
  } finally {
    if (abort) {
      signal.removeEventListener('abort', abort);
    }
  }
}

// Return a checked connection; the relay owner must forward bytes and enforce permit lifetime.
export async function connectEgressDestination(incoming: Socket,
  destination: { host: string; port: number }, transport: Transport = systemTransport) {
  const closed = new AbortController();
  function cancelled() {
    closed.abort();
  }
  function deadline() {
    return AbortSignal.any([closed.signal, AbortSignal.timeout(1000)]);
  }
  incoming.on('close', cancelled);
  incoming.on('end', cancelled);
  incoming.on('error', cancelled);
  let upstream: Socket | undefined;
  let reason = 'egress_destination_refused';
  try {
    const parsed = egressDestinationSchema.safeParse(destination);
    if (!parsed.success || incoming.destroyed) {
      throw new Error(reason);
    }
    const { host, port } = parsed.data;
    reason = 'egress_tls_refused';
    const initialData = await readEgressHello(incoming, host, deadline());
    reason = 'egress_dns_refused';
    const dnsDeadline = deadline();
    const answers = await bounded(transport.resolve(host), dnsDeadline);
    if (answers.length === 0) {
      throw new Error(reason);
    }
    for (const answer of answers) {
      if (![4, 6].includes(answer.family) || !isPublicAddress(answer)) {
        throw new Error(reason);
      }
    }
    // Pass only the checked numeric address; never let the connector resolve the hostname again.
    if (dnsDeadline.aborted || incoming.destroyed) {
      throw new Error(reason);
    }
    const address = answers[0]!.address;
    reason = 'egress_connect_refused';
    upstream = transport.connect(address, port);
    await once(upstream, 'connect', { signal: deadline() });
    return { upstream, initialData, address };
  } catch {
    incoming.destroy();
    upstream?.destroy();
    throw new Error(reason);
  } finally {
    incoming.off('close', cancelled);
    incoming.off('end', cancelled);
    incoming.off('error', cancelled);
  }
}
