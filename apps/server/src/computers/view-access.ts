import { z } from 'zod';
import type { Query } from '@opencrane/projections';
import {
  participation,
  participationChanges,
  legacyParticipation,
  conversationClosed,
  chatMembership,
} from '../chat/participation.ts';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import { isEventStoreUnavailable, type EventStore, type StoredEvent } from '@opencrane/event-store';
import {
  authorityFence, payingGroupAuthority, PayingGroupRefused, AuthorityApplying,
} from '@opencrane/models';
export interface ViewAccessOptions {
  silo: string;
  store: EventStore;
  binding: Binding;
  db: Query;
  deadline?: number;
}
export type ViewCheckBoundary =
  'event_store' | 'authorisation' | 'deadline' | 'authority_changed';
// Match the message thrown by the shared freshness check in libs/models/src/authority.ts.
const authorityChangedMessage = 'Authority changed';
// Keep a removed silo member as a denial while other team changes wait for IAM.
const activeSiloMembershipRequiredMessage = 'Active silo membership required';

export class ViewCheckUnavailable extends Error {
  readonly boundary: ViewCheckBoundary;

  constructor(
    boundary: ViewCheckBoundary,
    options?: ErrorOptions,
  ) {
    super('View authority unavailable', options);
    this.boundary = boundary;
  }
}
function isAuthorityMoved(error: unknown): boolean {
  if (error instanceof PayingGroupRefused) {
    return true;
  }
  if (error instanceof Error) {
    return error.message === authorityChangedMessage;
  }
  return false;
}

async function confirmSnapshotStillCurrent(fresh: () => Promise<void>) {
  try {
    await fresh();
  } catch (error) {
    if (!isAuthorityMoved(error)) {
      throw error;
    }
    // Treat this answer as unconfirmed: new events arrived on a watched stream
    // while this check ran, so the answer may be out of date.
    // Give it no lease time, but do not refuse access. The next check reads those
    // events and closes the view if access really ended.
    const errorOptions = { cause: error };
    throw new ViewCheckUnavailable('authority_changed', errorOptions);
  }
}

export const viewCheckMs = 1200;

const identity = z.object({ assistantId: z.string() });
const ready = identity.extend({ computerId: z.string(), generation: z.int().positive(), podUid: z.string().optional() });
const grant = z.object({ resourceType: z.string(), resourceId: z.string(), granteeId: z.string() });
const histories = new WeakMap<EventStore, Map<string, StoredEvent[]>>();

function saveHistory(cache: Map<string, StoredEvent[]>, key: string, rows: StoredEvent[]) {
  // Concurrent replies must not move the saved checkpoint backwards.
  if ((rows.at(-1)?.sequence ?? 0) < (cache.get(key)?.at(-1)?.sequence ?? 0)) return;
  // Keep up to 64 histories. If they grow too large, store only the event fields
  // this check needs.
  if (!cache.has(key) && cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, rows);
}

async function history(store: EventStore, subject: string, silo: string, deadline = Infinity) {
  let cache = histories.get(store);
  if (!cache) { cache = new Map(); histories.set(store, cache); }
  const key = JSON.stringify([silo, subject]);
  const rows = [...(cache.get(key) ?? [])];
  const previous = rows.at(-1); let confirmed = !previous;
  // Confirm the saved checkpoint before reading its live tail.
  for await (const row of store.readStream(subject, previous?.sequence ?? 1, deadline)) {
    if (row.event.silo !== silo) {
      throw new Error('Wrong silo');
    }
    if (!confirmed) {
      if (row.sequence !== previous?.sequence || row.event.id !== previous?.event.id) {
        break;
      }
      rows[rows.length - 1] = row;
      confirmed = true;
    } else {
      rows.push(row);
    }
  }
  if (!confirmed) { cache.delete(key); throw new Error('Authority history changed'); }
  saveHistory(cache, key, rows);
  return rows;
}

/** Check authority as well as its projection: delayed revocations must fail closed. */
export async function viewAccess(options: ViewAccessOptions, memberId: string, conversationId: string) {
  // Retries share the existing check deadline, rather than starting a new budget per history.
  const deadline = Math.min(options.deadline ?? Infinity, performance.now() + viewCheckMs);
  const boundedOptions = { ...options, deadline };
  try {
    const computer = await checkViewAccess(boundedOptions, memberId, conversationId);
    // Handling a successful reply late must not renew an expired authority snapshot.
    if (performance.now() >= deadline) {
      throw new ViewCheckUnavailable('deadline');
    }
    return computer;
  } catch (error) {
    // Late checks and outages cannot revoke a lease renewed by another check.
    const errorOptions = { cause: error };
    if (performance.now() >= deadline) {
      throw new ViewCheckUnavailable('deadline', errorOptions);
    }
    if (isEventStoreUnavailable(error)) {
      throw new ViewCheckUnavailable('event_store', errorOptions);
    }
    throw error;
  }
}

function ignoreRemovalFailure(): void {}

async function checkViewAccess(options: ViewAccessOptions, memberId: string, conversationId: string) {
  const { store, silo } = options;
  if (options.binding.silo !== silo) throw new Error('Wrong silo');
  const auth = memberAuthorisation(options.binding);
  const denied = Promise.withResolvers<never>();
  function refuseRemovedMember(active: boolean) {
    if (!active) {
      denied.reject(new Error('Access changed'));
    }
    return active;
  }
  function refuseConversationRead(permission: Awaited<ReturnType<typeof auth.conversation>>) {
    if (permission.status === 'ok' && !permission.allowed) {
      denied.reject(new Error('Access changed'));
    }
    return permission;
  }
  const memberRead = chatMembership(store, silo, memberId, options.deadline);
  const permissionRead = auth.conversation(memberId, conversationId, 'read');
  async function refuseRemovedParticipant() {
    const changes = await participationChanges(store, silo, conversationId, options.deadline);
    if (changes.get(memberId)?.row.event.type === 'participant.removed') {
      denied.reject(new Error('Access changed'));
    }
  }
  const removalRead = refuseRemovedParticipant();
  void removalRead.catch(ignoreRemovalFailure);
  const authorityReads = [
    memberRead.then(refuseRemovedMember),
    conversationDesktop(options, memberId, conversationId, auth),
    permissionRead.then(refuseConversationRead),
  ] as const;
  // Stop on a known denial without waiting for slower reads. Keep their error handlers attached.
  const settledReads = Promise.allSettled(authorityReads);
  const results = await Promise.race([denied.promise, settledReads]);
  const [memberResult, computerResult, permissionResult] = results;
  for (const result of results) {
    if (result.status !== 'rejected') {
      continue;
    }
    const error: unknown = result.reason;
    if (!(error instanceof ViewCheckUnavailable) && !isEventStoreUnavailable(error)) {
      throw error;
    }
  }
  // Failed reads grant no authority, even when the remaining reads allow access.
  settledRead(memberResult);
  const computer = settledRead(computerResult);
  const permission = settledRead(permissionResult);
  if (permission.status === 'unavailable') {
    throw new ViewCheckUnavailable('authorisation');
  }
  return computer;
}

function settledRead<Value>(result: PromiseSettledResult<Value>): Value {
  if (result.status === 'rejected') {
    const error: unknown = result.reason;
    throw error;
  }
  return result.value;
}

async function conversationDesktop(options: ViewAccessOptions, memberId: string, conversationId: string,
  auth: ReturnType<typeof memberAuthorisation>) {
  const { store, silo } = options;
  const legacy = await legacyParticipation(store, options.db, silo, conversationId,
    options.deadline ?? Infinity);
  const access = await participation(store, silo, conversationId, memberId, legacy,
    options.deadline);
  if (access.created.mode !== 'agent_session') throw new Error('Access changed');
  const closed = await conversationClosed(store, options.db, silo, conversationId,
    options.deadline ?? Infinity);
  if (closed) throw new Error('Access changed');
  const assistantId = access.created.assistantId;
  async function checkDesktop() {
    const computer = await currentComputer(options, assistantId);
    const desktop = await desktopAccess(options, memberId, conversationId, computer.computerId);
    const permission = await auth.view(
      memberId, conversationId, computer.computerId, desktop.receipts);
    if (permission.status === 'unavailable') throw new ViewCheckUnavailable('authorisation');
    if (!permission.allowed) throw new Error('Access changed');
    await confirmSnapshotStillCurrent(desktop.fresh);
    return computer;
  }
  const reads = [auth.applied(access.joinEventId), checkDesktop()] as const;
  const [applied, computer] = await Promise.all(reads);
  if (!applied) throw new ViewCheckUnavailable('authorisation');
  return computer;
}

async function currentComputer({ store, silo, deadline }: ViewAccessOptions, assistantId: string) {
  const lifecycle = await history(store, `computer-${assistantId}`, silo, deadline);
  const latest = lifecycle.findLast(r => !r.event.type.startsWith('computer.turn_'))?.event;
  if (latest?.type !== 'computer.ready') throw new Error('Computer unavailable');
  const computer = ready.parse(latest.data);
  const claimed = ready.parse(lifecycle.findLast(r => r.event.type === 'computer.claimed')?.event.data);
  if (computer.assistantId !== assistantId || computer.computerId !== claimed.computerId || computer.generation !== claimed.generation) throw new Error('Computer changed');
  return computer;
}

async function desktopGrants(store: EventStore, silo: string, resource: string, deadline?: number) {
  const grants = await history(store, resource, silo, deadline);
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
      current.set(`${grantee.granteeKind}:${data.granteeId}`,
        { id: data.granteeId, kind: grantee.granteeKind, eventId: event.id });
    }
  }
  return current;
}
async function belongsToGroup(options: ViewAccessOptions, groupId: string, memberId: string) {
  const rows = await history(options.store, `team-${groupId}`, options.silo, options.deadline);
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

async function desktopAccess(options: ViewAccessOptions, memberId: string,
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
    // Use current event membership even when IAM has not applied a removal yet.
    if (!await belongsToGroup(options, groupId, memberId)) continue;
    try {
      const groupFence = await confirmTeamAuthority(options, memberId, groupId);
      groupFences.push(groupFence);
      receipts.push(source.eventId);
    } catch (error) {
      if (!(error instanceof ViewCheckUnavailable)) {
        throw error;
      }
      // Try the other granted teams before waiting for IAM to apply this one.
      unconfirmedTeam = error;
      continue;
    }
  }
  if (!receipts.length) {
    if (unconfirmedTeam) {
      throw unconfirmedTeam;
    }
    throw new Error('Desktop access required');
  }
  async function checkFresh() {
    await fresh();
    for (const groupFence of groupFences) await groupFence();
  }
  return { receipts, fresh: checkFresh };
}
