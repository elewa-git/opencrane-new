import { JetStreamApiError } from '@nats-io/jetstream';
import { setTimeout as delay } from 'node:timers/promises';
import type { EventStore } from '../src/index.ts';

const peerOffline = 'no suitable peers for placement, peer offline';

export async function waitForClusterStream(store: Pick<EventStore, 'ensureStream'>) {
  const deadline = performance.now() + 20_000;
  let lastRefusal: unknown;
  const expired = Promise.withResolvers<never>();
  function expire() {
    expired.reject(new Error('Cluster placement exceeded 20000 ms; creation result is unknown',
      { cause: lastRefusal }));
  }
  const timer = setTimeout(expire, 20_000);
  try {
    await pollPlacement();
  } finally {
    clearTimeout(timer);
  }
  async function pollPlacement() {
    while (performance.now() < deadline) {
      try {
        const attempt = store.ensureStream({ replicas: 3 });
        await Promise.race([attempt, expired.promise]);
        return;
      } catch (error) {
        // Retry only a definite refusal: a timeout cannot prove that creation failed.
        if (!(error instanceof JetStreamApiError) || error.status !== 400 ||
          error.code !== 10005 || error.apiError().description !== peerOffline) {
          throw error;
        }
        lastRefusal = error;
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        await delay(Math.min(25, remaining));
      }
    }
    throw new Error(`Cluster placement did not become ready within 20000 ms: ${peerOffline}`,
      { cause: lastRefusal });
  }
}
