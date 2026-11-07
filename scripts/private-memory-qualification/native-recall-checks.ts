import { createHash } from 'node:crypto';
import { checkNative } from './native-checks.ts';

function requireSilo(siloId: string): void {
  const silo = process.env['SILO_ID'];
  if (!silo) {
    throw new Error('journey_unavailable');
  }
  const hash = createHash('sha256');
  hash.update(silo);
  if (`sha256:${hash.digest('hex')}` !== siloId) {
    throw new Error('journey_unavailable');
  }
}

export async function checkRecallPrerequisites(siloId: string, challengeId: string): Promise<void> {
  requireSilo(siloId);
  await checkNative(challengeId);
  requireSilo(siloId);
  // Keep recall NOT RUN: empty native threads do not prove a memory-bearing answer.
}
