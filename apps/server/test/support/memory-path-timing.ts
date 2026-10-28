import { vi } from 'vitest';
import type { fixture } from '@opencrane/models/testing';
import * as delivery from '../../src/memory/recall-delivery.ts';
import * as lineage from '../../src/memory/agent-lineage.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Step = 'history' | 'scope' | 'IAM' | 'grant' | 'loaded-reference';

// Record only step names and elapsed times. Never record arguments or failures.
export function timeMemoryPath(setup: Fixture, slowStep: Step, delay: () => Promise<void>) {
  const started = performance.now();
  const samples: { step: Step; startedMs: number; durationMs: number }[] = [];
  let delayed = false;
  async function measure<Value>(step: Step, work: () => Promise<Value>) {
    const before = performance.now();
    try {
      if (step === slowStep && !delayed) {
        delayed = true;
        await delay();
      }
      return await work();
    } finally {
      const sample = { step, startedMs: Math.round(before - started),
        durationMs: Math.round(performance.now() - before) };
      samples.push(sample);
    }
  }
  const readContext = delivery.readRecallContext;
  function history(...args: Parameters<typeof readContext>) {
    function read() {
      return readContext(...args);
    }
    return measure('history', read);
  }
  const checkReferences = lineage.checkAgentChange;
  function loaded(...args: Parameters<typeof checkReferences>) {
    function check() {
      return checkReferences(...args);
    }
    return measure('loaded-reference', check);
  }
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  async function* stream(...args: Parameters<typeof readStream>) {
    const subject = args[0];
    const before = performance.now();
    try {
      yield* readStream(...args);
    } finally {
      let step: Step | undefined;
      if (subject.startsWith('scope-')) {
        step = 'scope';
      }
      if (subject.startsWith('grant-')) {
        step = 'grant';
      }
      if (step) {
        const sample = { step, startedMs: Math.round(before - started),
          durationMs: Math.round(performance.now() - before) };
        samples.push(sample);
      }
    }
  }
  const originalApplied = setup.auth.applied.bind(setup.auth);
  function applied(eventId: string) {
    function read() {
      return originalApplied(eventId);
    }
    return measure('IAM', read);
  }
  const originalUse = setup.auth.use.bind(setup.auth);
  function use(...args: Parameters<typeof originalUse>) {
    function read() {
      return originalUse(...args);
    }
    return measure('IAM', read);
  }
  const spies = [
    vi.spyOn(delivery, 'readRecallContext').mockImplementation(history),
    vi.spyOn(lineage, 'checkAgentChange').mockImplementation(loaded),
    vi.spyOn(setup.nats.store, 'readStream').mockImplementation(stream),
    vi.spyOn(setup.auth, 'applied').mockImplementation(applied),
    vi.spyOn(setup.auth, 'use').mockImplementation(use),
  ];
  function report(operation: string, revoked: boolean) {
    const result = { operation, slowStep, revoked, elapsedMs: Math.round(performance.now() - started),
      samples };
    process.stdout.write(`Memory backend timing: ${JSON.stringify(result)}\n`);
  }
  function restore() {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
  function wasDelayed() {
    return delayed;
  }
  return { report, restore, delayed: wasDelayed };
}
