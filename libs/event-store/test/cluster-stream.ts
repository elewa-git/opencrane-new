import type { EventStore } from '../src/index.ts';

export async function waitForClusterStream(store: Pick<EventStore, 'ensureStream'>) {
  await store.ensureStream({ replicas: 3 });
}
