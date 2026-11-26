import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import {
  authorityFence, payingGroupAuthority, PayingGroupRefused, AuthorityApplying,
} from '@opencrane/models';
import { ChatRefused } from '../chat/access.ts';
import { accessHistory, ViewCheckUnavailable, type ViewAccessOptions } from './view-access.ts';

// Refuse a removed member even if the permissions service still has its old record.
const activeSiloMembershipRequiredMessage = 'Active silo membership required';
const grant = z.object({ resourceType: z.string(), resourceId: z.string(), granteeId: z.string() });

async function desktopGrants(store: EventStore, silo: string, resource: string, deadline?: number) {
  const grants = await accessHistory(store, resource, silo, deadline);
  const current = new Map<string, { id: string; kind: string; eventId: string }>();
  for (const { event } of grants) {
    const data = grant.parse(event.data);
    if (event.type === 'grant.revoked') {
      const revoked = z.object({ granteeKind: z.string().optional() }).parse(event.data);
      const kinds = revoked.granteeKind ? [revoked.granteeKind] : ['member', 'team', 'assistant'];
      for (const kind of kinds) {
        current.delete(`${kind}:${data.granteeId}`);
      }
    } else {
      const grantee = z.object({ granteeKind: z.string() }).parse(event.data);
      const recorded = { id: data.granteeId, kind: grantee.granteeKind, eventId: event.id };
      current.set(`${grantee.granteeKind}:${data.granteeId}`, recorded);
    }
  }
  return current;
}
async function belongsToGroup(options: ViewAccessOptions, groupId: string, memberId: string) {
  const rows = await accessHistory(options.store, `team-${groupId}`, options.silo, options.deadline);
  function matchesMember(row: StoredEvent) {
    if (!row.event.type.startsWith('team.member_')) return false;
    const data = z.object({ memberId: z.string() }).parse(row.event.data);
    return data.memberId === memberId;
  }
  const membership = rows.findLast(matchesMember);
  return membership?.event.type === 'team.member_added';
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
  const current = await desktopGrants(store, silo, resource, options.deadline);
  const direct = current.get(`member:${memberId}`);
  if (direct?.kind === 'member') return { receipts: [direct.eventId], fresh };
  const groupFences: (() => Promise<void>)[] = [];
  const receipts: string[] = [];
  let unconfirmedTeam: ViewCheckUnavailable | undefined;
  for (const source of current.values()) {
    const groupId = source.id;
    if (source.kind !== 'team') continue;
    // Check saved membership even if the permissions service has yet to apply a removal.
    if (!await belongsToGroup(options, groupId, memberId)) continue;
    try {
      const groupFence = await confirmTeamAuthority(options, memberId, groupId);
      groupFences.push(groupFence);
      receipts.push(source.eventId);
    } catch (error) {
      if (!(error instanceof ViewCheckUnavailable)) {
        throw error;
      }
      // Try any other team with a grant while the permissions service catches up.
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
    for (const groupFence of groupFences) await groupFence();
  }
  return { receipts, fresh: checkFresh };
}
