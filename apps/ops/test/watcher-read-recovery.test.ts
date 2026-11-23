import { rm } from 'node:fs/promises';
import type { StoredEvent } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';
import { expect, it, vi } from 'vitest';
import { SandboxClient } from '../src/kubernetes.ts';
import { watchComputers } from '../src/lifecycle.ts';
import { computerFixture } from './computer-fixture.ts';

function lostComputer(sequence: number, computerId: string): StoredEvent {
  const assistantId = computerId;
  const event = envelope('test', `computer-${assistantId}`, 'computer.lost',
    { assistantId, computerId });
  return { sequence, event };
}

async function watchesPartialRead(gap: boolean) {
  const { nats, directory, stop, tokens } = await computerFixture();
  const first = lostComputer(1, 'first');
  const next = lostComputer(gap ? 3 : 2, 'next');
  const blocked = Promise.withResolvers<AbortController>();
  const recovered = Promise.withResolvers<void>();
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const applied = vi.spyOn(kube, 'forgetMode');
  const sink = vi.fn();
  let deadline = new AbortController();
  let interrupted = false;
  function readDeadline() {
    deadline = new AbortController();
    return deadline.signal;
  }
  const clock = vi.spyOn(AbortSignal, 'timeout').mockImplementation(readDeadline);
  vi.spyOn(nats.store, 'head').mockResolvedValue(next.sequence);
  async function* subscribe(fromSequence: number, signal?: AbortSignal) {
    if (fromSequence === 1) {
      yield first;
      if (!gap && !interrupted) {
        interrupted = true;
        const cancelled = Promise.withResolvers<void>();
        function finishRead() {
          cancelled.resolve();
        }
        signal?.addEventListener('abort', finishRead, { once: true });
        blocked.resolve(deadline);
        await cancelled.promise;
        return;
      }
    }
    yield next;
  }
  const subscriptions = vi.spyOn(nats.store, 'subscribe').mockImplementation(subscribe);
  function report(status: { phase: string }) {
    if (status.phase === 'recovered') recovered.resolve();
  }
  const reportRecovery = vi.fn(report);
  const work = watchComputers(nats.store, kube, tokens, sink,
    { silo: 'test', idleMs: 600_000, signal: stop.signal, reportRecovery });
  function captureFailure(error: unknown) {
    return error;
  }
  const outcome = work.catch(captureFailure);
  try {
    if (gap) {
      await expect(work).rejects.toThrow('EVENTS stream is incomplete');
      expect(applied.mock.calls).toEqual([['first']]);
      expect(reportRecovery).not.toHaveBeenCalled();
      return;
    }
    const expiry = await blocked.promise;
    expect(applied.mock.calls).toEqual([['first']]);
    expiry.abort();
    await expect(Promise.race([outcome, recovered.promise])).resolves.toBeUndefined();
    expect(subscriptions).toHaveBeenCalledTimes(2);
    expect(subscriptions.mock.calls[1]?.[0]).toBe(2);
    expect(applied.mock.calls).toEqual([['first'], ['next']]);
    expect(reportRecovery).toHaveBeenCalledWith(
      { operation: 'Computer watcher read', phase: 'retrying', attempts: 1 },
    );
  } finally {
    stop.abort();
    await outcome;
    clock.mockRestore();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it.each([false, true])('resumes an interrupted non-empty watcher read and refuses a gap: %s',
  watchesPartialRead);
