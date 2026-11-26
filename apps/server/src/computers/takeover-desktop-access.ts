import { grantGivenDataSchema, grantRevokedDataSchema } from '@opencrane/events';
import { grantStream } from '@opencrane/authz';
import { readStreamSummary, type EventStore, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import {
  authorityFence, payingGroupAuthority, PayingGroupRefused, AuthorityApplying,
} from '@opencrane/models';
import { ChatRefused } from '../chat/access.ts';
import { hasSavedGroupMember } from '../chat/groups.ts';
import { ViewCheckUnavailable, type ViewAccessOptions } from './view-access.ts';

// Refuse a removed member even if the permissions service still has its old record.
const activeSiloMembershipRequiredMessage = 'Active silo membership required';
type Grant = ReturnType<typeof grantGivenDataSchema.parse>;
type Grants = Map<Grant['granteeKind'], Map<string, string>>;

function emptyGrants(): Grants {
  return new Map();
}

function desktopGrantSize(grants: Grants) {
  let count = 0;
  for (const identities of grants.values()) {
    count += identities.size;
  }
  return count;
}

function addDesktopGrant(grants: Grants, row: StoredEvent) {
  const { event } = row;
  if (event.type === 'grant.given') {
    const data = grantGivenDataSchema.parse(event.data);
    requireGrantSubject(event.subject, data);
    let identities = grants.get(data.granteeKind);
    if (!identities) {
      identities = new Map();
      grants.set(data.granteeKind, identities);
    }
    identities.set(data.granteeId, event.id);
  } else if (event.type === 'grant.revoked') {
    const data = grantRevokedDataSchema.parse(event.data);
    requireGrantSubject(event.subject, data);
    if (data.granteeKind) {
      grants.get(data.granteeKind)?.delete(data.granteeId);
      return;
    }
    // Old revocations did not name an identity kind. Revoke it in every kind.
    for (const identities of grants.values()) {
      identities.delete(data.granteeId);
    }
  }
}

function requireGrantSubject(subject: string, data: { resourceType: string; resourceId: string }) {
  if (data.resourceType !== 'shared_desktop' || subject !== grantStream(data.resourceType,
    data.resourceId)) {
    throw new ChatRefused('Desktop grant refused');
  }
}

// Keep only current grants. Limit how many grants all cached computers can hold.
const desktopGrantSummary: SummaryKind<Grants> = {
  name: 'desktop-grants', keep: 64, empty: emptyGrants, add: addDesktopGrant,
  budget: { limit: 8192, size: desktopGrantSize },
};

function desktopGrants(store: EventStore, silo: string, resource: string, memberId: string,
  deadline = Infinity) {
  function relevantGrants(grants: Grants) {
    const direct = grants.get('member')?.get(memberId);
    const teams = new Map(grants.get('team'));
    return { direct, teams };
  }
  return readStreamSummary(store, silo, resource, desktopGrantSummary, deadline, relevantGrants);
}

async function confirmTeamAuthority(options: ViewAccessOptions, memberId: string,
  groupId: string) {
  try {
    return await payingGroupAuthority(
      options.store, options.silo, memberId, groupId, options.binding, options.deadline);
  } catch (error) {
    if (!(error instanceof PayingGroupRefused) && !(error instanceof AuthorityApplying)) {
      throw error;
    }
    if (error.message === activeSiloMembershipRequiredMessage) {
      throw error;
    }
    // Retry while the access system applies a team change or the store is slow.
    // Check events on each attempt so a real removal still denies access.
    const errorOptions = { cause: error };
    throw new ViewCheckUnavailable('authorisation', errorOptions);
  }
}

export async function controlDesktopAccess(options: ViewAccessOptions, memberId: string,
  conversationId: string, computerId: string) {
  const { store, silo } = options;
  const resource = grantStream('shared_desktop', computerId);
  const subjects = [`member-${memberId}`, `participation-${conversationId}`, resource];
  const fresh = await authorityFence(store, performance.now(), subjects, options.deadline);
  const { direct, teams } = await desktopGrants(store, silo, resource, memberId, options.deadline);
  if (direct) {
    return { receipts: [direct], fresh };
  }
  const groupFences: (() => Promise<void>)[] = [];
  const receipts: string[] = [];
  let unconfirmedTeam: ViewCheckUnavailable | undefined;
  for (const [groupId, eventId] of teams) {
    // Check saved membership even if OpenFGA still has the old record.
    if (!await hasSavedGroupMember(options, groupId, memberId, options.deadline)) {
      continue;
    }
    try {
      const groupFence = await confirmTeamAuthority(options, memberId, groupId);
      groupFences.push(groupFence);
      receipts.push(eventId);
    } catch (error) {
      if (!(error instanceof ViewCheckUnavailable)) {
        throw error;
      }
      // Keep checking other teams. One current team can grant control on its own.
      unconfirmedTeam = error;
    }
  }
  if (!receipts.length) {
    if (unconfirmedTeam) {
      throw unconfirmedTeam;
    }
    throw new ChatRefused('Desktop access required');
  }
  async function checkFresh() {
    await fresh();
    for (const groupFence of groupFences) {
      await groupFence();
    }
  }
  return { receipts, fresh: checkFresh };
}
