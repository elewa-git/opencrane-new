import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '@opencrane/observability';

const retryDelaysMs = [100, 200, 400, 800];

export type JetStreamRecoveryStatus = {
  operation: 'Dispatcher pull' | 'Computer watcher read';
  phase: 'retrying' | 'recovered' | 'exhausted';
  attempts: number;
};

export type JetStreamRecoveryReporter = (status: JetStreamRecoveryStatus) => void;

type RecoveryOptions = {
  operation: JetStreamRecoveryStatus['operation'];
  signal: AbortSignal;
  logger: Logger;
  isUnavailable: (error: unknown) => boolean;
  report?: JetStreamRecoveryReporter | undefined;
};

/** Retry reads or pulls that can resume from their last saved position. */
export async function recoverJetStreamOperation<Value>(
  read: () => Promise<Value>, options: RecoveryOptions,
): Promise<Value> {
  const { operation, signal, logger, isUnavailable, report } = options;
  let attempts = 0;
  while (true) {
    signal.throwIfAborted();
    let value: Value;
    try {
      value = await read();
    } catch (error) {
      signal.throwIfAborted();
      if (!isUnavailable(error)) throw error;
      const retryInMs = retryDelaysMs[attempts];
      if (retryInMs === undefined) {
        report?.({ operation, phase: 'exhausted', attempts });
        throw new Error(`${operation} recovery exhausted`, { cause: error });
      }
      attempts++;
      const fields = { err: error, operation, attempts, retryInMs };
      report?.({ operation, phase: 'retrying', attempts });
      const label = operation.toLowerCase();
      logger.warn(fields, `Retrying ${label} after JetStream failure`);
      await delay(retryInMs, undefined, { signal });
      continue;
    }
    if (attempts > 0 && !signal.aborted) {
      report?.({ operation, phase: 'recovered', attempts });
      logger.info({ operation, attempts }, `${operation} recovered`);
    }
    return value;
  }
}
