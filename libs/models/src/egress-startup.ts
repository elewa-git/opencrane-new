import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventStore } from '@opencrane/event-store';
import { egressObservationId } from '@opencrane/events';
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
      receipts.set(receipt.observationId, receipt);
      if (await receipt.retry() === 'refused') refused();
    } catch {
      refused();
    }
  }
  async function prepare(request: Parameters<EgressRelayRegistry['register']>[0]) {
    const binding = { requestId: request.permitId, permitId: request.permitId,
      channel: 'command' as const, host: request.host, port: request.port };
    const receipt = await createEgressReceipt(store, silo, binding, directory);
    receipts.set(receipt.observationId, receipt);
  }
  function capture(record: EgressCloseRecord) {
    const id = egressObservationId(silo, record.permitId);
    if (!receipts.get(id)?.capture(record)) refused();
  }
  const registry = new EgressRelayRegistry(capture, transport, prepare);
  let flushing: Promise<void> | undefined;
  async function retry(receipt: Awaited<ReturnType<typeof createEgressReceipt>>) {
    const status = await receipt.retry();
    if (status !== 'pending') {
      receipts.delete(receipt.observationId);
      if (status === 'refused') refused();
    }
  }
  async function flushReceipts() {
    const attempts = [...receipts.values()].map(retry);
    await Promise.all(attempts);
  }
  function flushed() {
    flushing = undefined;
  }
  function flush() {
    flushing ??= flushReceipts().finally(flushed);
    return flushing;
  }
  function retryPending() {
    // Join an unfinished batch. Each receipt already bounds its store reads and append.
    if (flushing) return;
    void flush().catch(refused);
  }
  const retryTimer = setInterval(retryPending, 1000);
  retryTimer.unref();
  async function close() {
    clearInterval(retryTimer);
    registry.closeAll('unavailable');
    let timer: NodeJS.Timeout | undefined;
    function deadline(resolve: () => void) {
      timer = setTimeout(resolve, 2000);
    }
    try {
      // Join receipts added after an earlier retry batch started too.
      const work = Promise.all([flushReceipts(), registry.waitForChecks()]);
      await Promise.race([work, new Promise<void>(deadline)]);
    } finally {
      clearTimeout(timer);
    }
  }
  return { registry, flush, close };
}
