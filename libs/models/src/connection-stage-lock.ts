import { createHash } from 'node:crypto';
import type { Db } from '@opencrane/projections';
import type { ConnectionStage, CompanyConnectionStage } from './connection-custody.ts';

type Profile = Pick<ConnectionStage, 'siloId' | 'userId' | 'serverId' | 'profileId'> |
  Pick<CompanyConnectionStage, 'siloId' | 'ownerKind' | 'serverId' | 'profileId'>;

/** Hold the same database lock across staging, append recovery and cleanup. */
export async function withConnectionStage<Result>(db: Pick<Db, 'lock'>,
  profile: Profile, work: () => Promise<Result>): Promise<Result> {
  if (!db.lock) {
    throw new Error('Connection coordination unavailable');
  }
  let owner = 'company:';
  if ('userId' in profile) {
    owner = profile.userId;
  }
  const coordinates = [profile.siloId, owner, profile.serverId, profile.profileId];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(coordinates));
  const name = `connection-stage:${hash.digest('hex')}`;
  let refusal: { error: unknown } | undefined;
  async function execute() {
    try {
      return { ok: true as const, result: await work() };
    } catch (error) {
      // Keep the command's refusal even if releasing the database lock later fails.
      refusal = { error };
      return { ok: false as const, error };
    }
  }
  // Hide database failures while preserving the command's own fixed refusal messages.
  let outcome: Awaited<ReturnType<typeof execute>>;
  // Allow the pool and PostgreSQL round trips the same one-second wait as a normal connection.
  // Acquire before loading history and checking access, so this wait grants no authority.
  const options = { timeoutMs: 1000 };
  try {
    outcome = await db.lock(name, execute, options);
  } catch {
    if (refusal) {
      throw refusal.error;
    }
    throw new Error('Connection coordination unavailable');
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.result;
}
