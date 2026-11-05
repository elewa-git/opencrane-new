import { AsyncLocalStorage } from 'node:async_hooks';
import type { turnRunner } from './turn-runner.ts';
import { requiredString, type Turn } from './turn-frame.ts';

type Launch = { turnId: string; conversation: string; expires: number;
  abort: AbortController; thread?: string };
export const privateLaunchContext = new AsyncLocalStorage<Launch>();

// Carry the authenticated turn into the driver's no-argument session opener.
export function launchBoundRunner(runner: ReturnType<typeof turnRunner>) {
  const pending = new Set<Launch>();
  async function run<Result>(input: Record<string, unknown>, work: () => Promise<Result>) {
    const launch: Launch = { turnId: requiredString(input, 'id'),
      conversation: requiredString(input, 'conversationId'), expires: Number(input['expiresAt']),
      abort: new AbortController() };
    pending.add(launch);
    try { return await privateLaunchContext.run(launch, work); }
    finally { pending.delete(launch); }
  }
  function start(input: Turn) {
    if (input.executionMode !== 'restricted') return runner.start(input);
    const work = runner.start.bind(runner, input);
    const identity = { id: input.id, conversationId: input.conversationId,
      expiresAt: input.expiresAt };
    return run(identity, work);
  }
  function prepareRoutine(input: Record<string, unknown>) {
    const work = runner.prepareRoutine.bind(runner, input);
    return run(input, work);
  }
  function cancelAll() {
    for (const launch of pending) launch.abort.abort();
  }
  function connectionLost() {
    cancelAll();
    runner.connectionLost();
  }
  function interrupt(input: Record<string, unknown>, cleared?: () => void) {
    for (const launch of pending) {
      if (launch.turnId === input['turnId'] && launch.conversation === input['conversationId']
        && (input['threadId'] === undefined || input['threadId'] === launch.thread)) {
        launch.abort.abort();
      }
    }
    return runner.interrupt(input, cleared);
  }
  function stopBridge(input: Record<string, unknown>, accept: (value: Record<string, unknown>) => void) {
    const receipt = runner.stopBridge(input, accept);
    cancelAll();
    return receipt;
  }
  return { gate: runner.gate, start, prepareRoutine, connectionLost, interrupt, stopBridge,
    loadRecall: runner.loadRecall.bind(runner),
    acknowledge: runner.acknowledge.bind(runner), readArtifact: runner.readArtifact.bind(runner) };
}
