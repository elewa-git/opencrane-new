import { createHash } from 'node:crypto';
import type { Db } from '@opencrane/projections';
import type { ConnectionStage } from './connection-custody.ts';

type Profile = Pick<ConnectionStage, 'siloId' | 'userId' | 'serverId' | 'profileId'>;

/** Hold the same database lock across staging, append recovery and cleanup. */
export async function withConnectionStage<Result>(db: Pick<Db, 'lock'>,
  profile: Profile, work: () => Promise<Result>): Promise<Result> {
  if (!db.lock) {
    throw new Error('Connection coordination unavailable');
  }
  const coordinates = [profile.siloId, profile.userId, profile.serverId, profile.profileId];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(coordinates));
  const name = `connection-stage:${hash.digest('hex')}`;
  async function execute() {
    try {
      return { ok: true as const, result: await work() };
    } catch (error) {
      return { ok: false as const, error };
    }
  }
  // Hide database failures while preserving the command's own fixed refusal messages.
  let outcome: Awaited<ReturnType<typeof execute>>;
  const options = { timeoutMs: 100 };
  try {
    outcome = await db.lock(name, execute, options);
  } catch {
    throw new Error('Connection coordination unavailable');
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.result;
}
