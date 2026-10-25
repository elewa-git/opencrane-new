import { JetStreamApiError } from '@nats-io/jetstream';
import { vi } from 'vitest';
import type { EventStore } from '../src/index.ts';

const peerOffline = 'no suitable peers for placement, peer offline';

export async function waitForClusterStream(store: Pick<EventStore, 'ensureStream'>) {
  async function placementReady() {
    try {
      await store.ensureStream({ replicas: 3 });
      return true;
    } catch (error) {
      // Wait only for missing placement statistics, never a refusal or a lost reply.
      if (error instanceof JetStreamApiError && error.status === 400 &&
        error.code === 10005 && error.apiError().description === peerOffline) {
        return false;
      }
      throw error;
    }
  }
  await vi.waitUntil(placementReady, { timeout: 5000 });
}
