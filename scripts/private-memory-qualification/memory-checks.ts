import { createHash, randomUUID } from 'node:crypto';
import { connectEventStore } from '@opencrane/event-store';
import { memoryKeys } from '@opencrane/projections';
import type { MemoryIdentity } from '@opencrane/events';
import { memoryJourney } from '../../apps/server/test/support/memory-journey.ts';

export async function checkMemory(name: 'invalidation' | 'unrelatedActivity', siloId: string) {
  const silo = process.env['SILO_ID'];
  const directory = process.env['MEMORY_KEY_DIRECTORY'];
  if (!silo || !directory) throw new Error('journey_unavailable');
  const hash = createHash('sha256');
  hash.update(silo);
  if (`sha256:${hash.digest('hex')}` !== siloId) throw new Error('journey_unavailable');
  const keys = memoryKeys(directory);
  function encode(identity: MemoryIdentity) {
    keys.provision(identity);
    return keys.encrypt(identity, randomUUID());
  }
  const connection = await connectEventStore();
  try {
    for (const kind of ['corrected', 'forgotten'] as const) {
      const identity = randomUUID();
      const journey = memoryJourney(connection.store, silo, identity, identity, randomUUID(), encode);
      await journey.start();
      if (name === 'invalidation') {
        await journey.exactInvalidation(kind);
      } else {
        await journey.unrelatedChange(kind);
      }
    }
  } finally {
    await connection.close();
  }
}
