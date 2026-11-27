import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { memberAuthorisation } from '@opencrane/authz';
import { siloOwnerBootstrappedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { currentMembership } from '@opencrane/models';
import type { GroupOptions } from './group-routes.ts';

const bootstrapOwner = siloOwnerBootstrappedDataSchema.shape.memberId.value;
const claimWindowMs = 30_000;
const waitLimitMs = 5_000;
const pollIntervalMs = 100;

export interface InvitationAccount {
  issuer: string;
  sub: string;
}

type ClaimDependency = 'members_projection' | 'ownership_worker' | 'openfga';
type InvitationAccessOptions = Omit<GroupOptions, 'db'>;

export class InvitationAccessUnavailable extends Error {
  readonly dependency: ClaimDependency;

  constructor(dependency: ClaimDependency, message: string, options?: ErrorOptions) {
    super(message, options);
    this.dependency = dependency;
  }
}

export async function invitationActor(options: InvitationAccessOptions,
  account: InvitationAccount, time: Date, log: FastifyBaseLogger) {
  const deadline = performance.now() + waitLimitMs;
  let waitingFor: ClaimDependency | undefined;
  while (true) {
    const actor = await options.feed.memberId(options.silo, account.issuer, account.sub);
    if (actor && actor !== bootstrapOwner) return actor;
    const dependency = await claimStillApplying(options, account, actor, time, deadline);
    if (!dependency) return actor;
    if (waitingFor !== dependency) {
      log.warn({ dependency }, 'First-owner invitation access is still being applied');
      waitingFor = dependency;
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= pollIntervalMs) {
      throw new InvitationAccessUnavailable(dependency, 'First-owner invitation access wait expired');
    }
    await delay(pollIntervalMs);
  }
}

function isOwnerFact(row: StoredEvent) {
  return row.event.subject === `member-${bootstrapOwner}`;
}

function isRecentClaim(row: StoredEvent | undefined, account: InvitationAccount, time: Date) {
  if (row?.event.type !== 'silo.owner_bootstrapped') return false;
  const ageMs = time.getTime() - Date.parse(row.event.time);
  if (ageMs < 0 || ageMs >= claimWindowMs) return false;
  const { identity } = siloOwnerBootstrappedDataSchema.parse(row.event.data);
  return identity.issuer === account.issuer && identity.sub === account.sub;
}

async function claimStillApplying(options: InvitationAccessOptions, account: InvitationAccount,
  actor: string | undefined, time: Date, deadline: number): Promise<ClaimDependency | undefined> {
  const membership = await currentMembership(
    options.store, options.silo, bootstrapOwner, undefined, deadline);
  const claim = membership.facts.findLast(isOwnerFact);
  // Wait only for the account that made the live first-owner claim.
  if (!claim || membership.role !== 'owner' || !isRecentClaim(claim, account, time)) return undefined;
  if (!actor) return 'members_projection';
  const seed = membership.ownership[0];
  if (!seed) return 'ownership_worker';
  const auth = memberAuthorisation(options.binding);
  for (const row of [claim, seed]) {
    const receipt = await auth.checkApplied(row.event.id);
    if (receipt.status === 'unavailable') {
      const cause = { cause: receipt.error };
      throw new InvitationAccessUnavailable('openfga', 'OpenFGA receipt check unavailable', cause);
    }
    if (!receipt.allowed) return 'openfga';
  }
  // Keep the usual role and permission checks before the invitation is saved.
  return undefined;
}
