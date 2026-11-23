import { createLogger } from '@opencrane/observability';
import { afterEach, expect, it, vi } from 'vitest';
import { recoverJetStreamOperation, type JetStreamRecoveryOptions } from '../src/index.ts';

const unavailable = new Error('Temporary JetStream failure');
const permanent = new Error('Permanent JetStream failure');
const logger = createLogger('recovery-test', { level: 'silent' });

function fixture() {
  vi.useFakeTimers();
  const stop = new AbortController();
  function isUnavailable(error: unknown) {
    return error === unavailable;
  }
  const report = vi.fn();
  const options: JetStreamRecoveryOptions = {
    operation: 'Dispatcher pull', signal: stop.signal, logger, isUnavailable, report,
  };
  return { stop, report, options };
}

afterEach(vi.useRealTimers);

async function waitsBeforeEachRetry() {
  const { options, report } = fixture();
  const read = vi.fn<() => Promise<string>>()
    .mockRejectedValueOnce(unavailable)
    .mockRejectedValueOnce(unavailable)
    .mockRejectedValueOnce(unavailable)
    .mockRejectedValueOnce(unavailable)
    .mockResolvedValue('reply');
  const result = recoverJetStreamOperation(read, options);
  const waits = [100, 200, 400, 800];
  for (const [index, wait] of waits.entries()) {
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(read).toHaveBeenCalledTimes(index + 1);
    expect(report).toHaveBeenLastCalledWith(
      { operation: 'Dispatcher pull', phase: 'retrying', attempts: index + 1 },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(index + 2);
  }
  await expect(result).resolves.toBe('reply');
  expect(report).toHaveBeenLastCalledWith(
    { operation: 'Dispatcher pull', phase: 'recovered', attempts: 4 },
  );
}
it('waits 100, 200, 400 and 800 ms before successive retries', waitsBeforeEachRetry);

async function cancelsBackoff() {
  const { stop, options, report } = fixture();
  const read = vi.fn<() => Promise<string>>().mockRejectedValue(unavailable);
  const result = recoverJetStreamOperation(read, options);
  const rejected = expect(result).rejects.toHaveProperty('name', 'AbortError');
  await vi.advanceTimersByTimeAsync(50);
  expect(read).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledTimes(1);
  stop.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(1500);
  expect(read).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledTimes(1);
}
it('cancels a scheduled retry during its backoff wait', cancelsBackoff);

async function rejectsPermanentFailure() {
  const { options, report } = fixture();
  const read = vi.fn<() => Promise<string>>().mockRejectedValue(permanent);
  const result = recoverJetStreamOperation(read, options);
  const rejected = expect(result).rejects.toBe(permanent);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
  await rejected;
}
it('rejects a permanent failure immediately', rejectsPermanentFailure);
