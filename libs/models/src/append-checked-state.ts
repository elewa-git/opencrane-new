import type { AppendCommand, AppendResult, EventStore } from '@opencrane/event-store';

// Keep the global condition for atomic checks across streams. Retry a definite conflict
// only after checking the original state and access again, within the original deadline.
export async function appendCheckedState(
  store: Pick<EventStore, 'append' | 'head'>,
  command: AppendCommand & { expectedGlobalSequence: number; deadline: number },
  unchanged: () => Promise<boolean>,
): Promise<AppendResult> {
  let expectedGlobalSequence = command.expectedGlobalSequence;
  while (performance.now() < command.deadline) {
    if (!await unchanged()) {
      return { status: 'conflict' };
    }
    const attempt = { ...command, expectedGlobalSequence };
    const result = await store.append(attempt);
    if (result.status !== 'conflict') {
      return result;
    }
    const latest = await store.head(undefined, command.deadline);
    if (latest === expectedGlobalSequence) {
      return result;
    }
    expectedGlobalSequence = latest;
  }
  return { status: 'unavailable', cause: new Error('State check deadline expired') };
}
