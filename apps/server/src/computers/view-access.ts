import { ChatRefused } from '../chat/access.ts';
import { isComputerLifecycle } from '@opencrane/auth';
import { z } from 'zod';
import type { Query } from '@opencrane/projections';
import {
  participation,
  participationChanges,
  legacyParticipation,
  conversationClosed,
  chatMembership,
} from '../chat/participation.ts';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { isEventStoreUnavailable, type EventStore, type StoredEvent } from '@opencrane/event-store';

export interface ViewAccessOptions {
  silo: string;
  store: EventStore;
  binding: Binding;
  db: Query;
  deadline?: number;
}
export type ViewCheckBoundary = 'event_store' | 'authorisation' | 'deadline';

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
// Leave time within the 1,500 ms viewer lease to act on a completed check.
export const viewCheckMs = 1200;

const identity = z.object({ assistantId: z.string() });
const ready = identity.extend({ computerId: z.string(), generation: z.int().positive(), podUid: z.string().optional() });
const histories = new WeakMap<EventStore, Map<string, StoredEvent[]>>();

function saveHistory(cache: Map<string, StoredEvent[]>, key: string, rows: StoredEvent[]) {
  // Concurrent replies must not move the saved checkpoint backwards.
  if ((rows.at(-1)?.sequence ?? 0) < (cache.get(key)?.at(-1)?.sequence ?? 0)) return;
  // Keep only the 64 most recently added stream histories.
  if (!cache.has(key) && cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, rows);
}

export async function accessHistory(
  store: EventStore, subject: string, silo: string, deadline = Infinity,
) {
  let cache = histories.get(store);
  if (!cache) {
    cache = new Map();
    histories.set(store, cache);
  }
  const key = JSON.stringify([silo, subject]);
  const rows = [...(cache.get(key) ?? [])];
  const previous = rows.at(-1);
  let confirmed = !previous;
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
  if (!confirmed) {
    cache.delete(key);
    throw new Error('Authority history changed');
  }
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
      denied.reject(new ChatRefused('Access changed'));
    }
    return active;
  }
  function refuseConversationRead(permission: Awaited<ReturnType<typeof auth.conversation>>) {
    if (permission.status === 'ok' && !permission.allowed) {
      denied.reject(new ChatRefused('Access changed'));
    }
    return permission;
  }
  const memberRead = chatMembership(store, silo, memberId, options.deadline);
  const permissionRead = auth.conversation(memberId, conversationId, 'read');
  async function refuseRemovedParticipant() {
    const changes = await participationChanges(store, silo, conversationId, options.deadline);
    if (changes.get(memberId)?.row.event.type === 'participant.removed') {
      denied.reject(new ChatRefused('Access changed'));
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
  if (access.created.mode !== 'agent_session') throw new ChatRefused('Access changed');
  const closed = await conversationClosed(store, options.db, silo, conversationId,
    options.deadline ?? Infinity);
  if (closed) throw new ChatRefused('Access changed');
  const reads = [
    auth.applied(access.joinEventId),
    currentComputer(options, access.created.assistantId),
  ] as const;
  const [applied, computer] = await Promise.all(reads);
  if (!applied) throw new ViewCheckUnavailable('authorisation');
  return computer;
}

function isLifecycleRow(row: StoredEvent) {
  return isComputerLifecycle(row.event.type);
}

function isClaimedRow(row: StoredEvent) {
  return row.event.type === 'computer.claimed';
}

async function currentComputer({ store, silo, deadline }: ViewAccessOptions, assistantId: string) {
  const lifecycle = await accessHistory(store, `computer-${assistantId}`, silo, deadline);
  const latest = lifecycle.findLast(isLifecycleRow)?.event;
  if (latest?.type !== 'computer.ready') throw new Error('Computer unavailable');
  const computer = ready.parse(latest.data);
  const claimedRow = lifecycle.findLast(isClaimedRow);
  const claimed = ready.parse(claimedRow?.event.data);
  if (computer.assistantId !== assistantId || computer.computerId !== claimed.computerId ||
      computer.generation !== claimed.generation) {
    throw new Error('Computer changed');
  }
  return computer;
}
