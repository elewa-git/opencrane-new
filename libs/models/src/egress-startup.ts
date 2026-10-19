import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStore } from '@opencrane/event-store';
import { createEgressReceipt, recoverEgressReceipt } from './egress-receipt.ts';
import { EgressRelayRegistry, type EgressCloseRecord } from './egress-relay.ts';
import type { EgressTransport } from './egress-guard.ts';

export async function startEgress(store: EventStore, silo: string, stateDirectory: string,
  refused: () => void, transport?: EgressTransport) {
  const directory = join(stateDirectory, 'egress');
  let retained: string[];
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || (details.mode & 0o777) !== 0o700) {
      throw new Error('egress_directory_refused');
    }
    retained = await readdir(directory);
  } catch {
    throw new Error('egress_directory_refused');
  }
  const receipts = new Map<string, Awaited<ReturnType<typeof createEgressReceipt>>>();
  for (const name of retained) {
    try {
      const receipt = await recoverEgressReceipt(store, silo, directory, name);
      if (await receipt.retry() === 'refused') refused();
    } catch {
      refused();
    }
  }
  async function prepare(request: Parameters<EgressRelayRegistry['register']>[0]) {
    const binding = { requestId: request.permitId, permitId: request.permitId,
      channel: 'command' as const, host: request.host, port: request.port };
    const receipt = await createEgressReceipt(store, silo, binding, directory);
    receipts.set(request.permitId, receipt);
  }
  function capture(record: EgressCloseRecord) {
    if (!receipts.get(record.permitId)?.capture(record)) refused();
  }
  const registry = new EgressRelayRegistry(capture, transport, prepare);
  async function flush() {
    for (const receipt of receipts.values()) {
      if (await receipt.retry() === 'refused') refused();
    }
  }
  async function close() {
    registry.closeAll('unavailable');
    let timer: NodeJS.Timeout | undefined;
    function deadline(resolve: () => void) {
      timer = setTimeout(resolve, 2000);
    }
    try {
      await Promise.race([flush(), new Promise<void>(deadline)]);
    } finally {
      clearTimeout(timer);
    }
  }
  return { registry, flush, close };
}
