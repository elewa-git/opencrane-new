import type { NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';
import type { storageClient } from '../../apps/server/src/files/storage.ts';
import { captureBounds } from './event-backup.ts';
import { restoreEventBackup } from './event-restore.ts';
import { checkObjectBackup, restoreObjectBackup } from './object-restore.ts';
import { inspectDisposableObjectTarget } from './disposable-object-target.ts';
import { claimRecoveryEventTarget } from './recovery-event-target.ts';

type Storage = ReturnType<typeof storageClient>;
type Options = Omit<Parameters<typeof restoreObjectBackup>[3], 'proof'> & {
  effectsDisabled: boolean;
};

/** Restore bytes only. Keep both targets isolated until separate recovery checks permit reads. */
export async function restoreRecoveryBackup(source: NatsConnection, target: NatsConnection,
  sourceObjects: Storage, targetObjects: Storage, options: Options) {
  const controller = new AbortController();
  let bounds: ReturnType<typeof captureBounds> | undefined;
  let signal: AbortSignal | undefined;
  function closeTransfer() {
    void target.close().catch(ignoreFailure);
  }
  try {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
        options.stopped !== true || options.effectsDisabled !== true ||
        options.exclusive !== true || options.disposable !== true ||
        options.targetSilo !== options.silo || sourceObjects.endpoint === targetObjects.endpoint) {
      throw new Error('Invalid recovery conditions');
    }
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const checkEvents = claimRecoveryEventTarget(target, options.silo);
    const checkObjects = inspectDisposableObjectTarget(targetObjects, options.silo, signal);
    signal.addEventListener('abort', closeTransfer, { once: true });
    const requestBounds = { signal, timeoutMs };
    bounds = captureBounds(target, requestBounds);
    const boundedOptions = { ...options, signal, timeoutMs };
    await bounds.bounded(checkObjectBackup(source, boundedOptions));
    const empty = z.object({ error: z.never().optional(), total: z.literal(0),
      streams: z.array(z.string()).length(0).nullish() });
    empty.parse(await bounds.request('$JS.API.STREAM.NAMES', {}));
    async function preflightStorage() {
      await checkObjects();
      const buckets = await targetObjects.listBuckets();
      if (buckets.length !== 1 || buckets[0]?.name !== 'opencrane-restore') {
        throw new Error('Occupied recovery target');
      }
    }
    await bounds.bounded(targetObjects.withBounds(requestBounds, preflightStorage));
    checkEvents();
    bounds.check();
    const eventOptions = { directory: options.eventDirectory, silo: options.silo,
      disposable: true, signal, timeoutMs };
    const proof = await restoreEventBackup(source, target, eventOptions);
    checkEvents();
    bounds.check();
    // Pass the native result unchanged; object restore checks the restored creation time too.
    const objectOptions = { ...boundedOptions, proof };
    await restoreObjectBackup(target, sourceObjects, targetObjects, objectOptions);
    checkEvents();
    bounds.check();
    return { kind: 'events-and-objects-only' as const };
  } catch {
    // Never erase or resend: either service may have saved bytes before losing its reply.
    throw new Error('Recovery restore refused; keep both targets isolated');
  } finally {
    signal?.removeEventListener('abort', closeTransfer);
    controller.abort();
    bounds?.dispose();
  }
}
function ignoreFailure() {}
