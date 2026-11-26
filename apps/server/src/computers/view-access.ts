import {
  chatAccess, ChatAccessApplying, ChatRefused, isChatRefused,
} from '../chat/access.ts';
import { isPublicChatId } from '../chat/public-id.ts';
import { conversationClosed, participationChanges } from '../chat/participation.ts';
import { isComputerLifecycle } from '@opencrane/auth';
import { AuthorisationUnavailable, type Binding } from '@opencrane/authz';
import { AuthorityApplying } from '@opencrane/models';
import {
  isEventStoreUnavailable, WrongSiloError, type EventStore, type StoredEvent,
} from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';
import { z } from 'zod';

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

  constructor(boundary: ViewCheckBoundary, options?: ErrorOptions) {
    super('View authority unavailable', options);
    this.boundary = boundary;
  }
}

export class ViewAccessRefused extends ChatRefused {}

// Leave time within the 1,500 ms viewer lease to act on a completed check.
export const viewCheckMs = 1200;

const computerIdentity = z.object({
  assistantId: z.string(), computerId: z.string(), generation: z.int().positive(),
});
const ready = computerIdentity.extend({ podUid: z.string().optional() });
type ViewComputer = z.infer<typeof ready>;

export function sameViewComputer(first: ViewComputer, second: ViewComputer) {
  return first.assistantId === second.assistantId && first.computerId === second.computerId
    && first.generation === second.generation && first.podUid === second.podUid;
}

export async function viewAccess(options: ViewAccessOptions, memberId: string,
  conversationId: string) {
  const deadline = Math.min(options.deadline ?? Infinity, performance.now() + viewCheckMs);
  try {
    const computer = await checkViewAccess(options, memberId, conversationId, deadline);
    // Do not renew a view with a reply that arrived after the check expired.
    if (performance.now() >= deadline) {
      throw new ViewCheckUnavailable('deadline');
    }
    return computer;
  } catch (error) {
    const cause = { cause: error };
    if (isChatRefused(error) || error instanceof ChatAccessApplying ||
        error instanceof AuthorityApplying || error instanceof WrongSiloError) {
      throw new ViewAccessRefused('Chat access refused', cause);
    }
    if (performance.now() >= deadline) {
      throw new ViewCheckUnavailable('deadline', cause);
    }
    if (isEventStoreUnavailable(error)) {
      throw new ViewCheckUnavailable('event_store', cause);
    }
    if (error instanceof AuthorisationUnavailable) {
      throw new ViewCheckUnavailable('authorisation', cause);
    }
    throw error;
  }
}

async function checkViewAccess(options: ViewAccessOptions, memberId: string,
  conversationId: string, deadline: number) {
  if (options.silo !== options.binding.silo || !isPublicChatId(conversationId)) {
    throw new ChatRefused('Conversation refused');
  }
  // Let a saved closure or removal stop delivery while another check is still waiting.
  const open = requireOpenConversation(options, conversationId, deadline);
  const current = requireNoRemoval(options, memberId, conversationId, deadline);
  const access = { memberId, conversationId, deadline };
  const chat = chatAccess(options, access);
  const [reader] = await Promise.all([chat, open, current]);
  if (reader.conversation?.mode !== 'agent_session') {
    throw new ChatRefused('Conversation has no computer');
  }
  return currentComputer(options, reader.conversation.assistantId, deadline);
}

async function requireOpenConversation({ store, db, silo }: ViewAccessOptions,
  conversationId: string, deadline: number) {
  if (await conversationClosed(store, db, silo, conversationId, deadline)) {
    throw new ChatRefused('Conversation closed');
  }
}

async function requireNoRemoval({ store, silo }: ViewAccessOptions, memberId: string,
  conversationId: string, deadline: number) {
  const changes = await participationChanges(store, silo, conversationId, deadline);
  if (changes.get(memberId)?.row.event.type === 'participant.removed') {
    throw new ChatRefused('Conversation participation ended');
  }
}

interface ComputerState {
  checkpoint?: StoredEvent;
  latest?: StoredEvent;
  claim?: StoredEvent;
}

const computers = new WeakMap<EventStore, Map<string, ComputerState>>();
// Keep at most three event records for each recent computer, even during long chats.
const computersToKeep = 64;

function computerCache(store: EventStore) {
  let cache = computers.get(store);
  if (!cache) {
    cache = new Map();
    computers.set(store, cache);
  }
  return cache;
}

function keepComputerState(cache: Map<string, ComputerState>, key: string, state: ComputerState) {
  const saved = cache.get(key);
  // Allow checks to overlap. A slow reply cannot move the saved position back.
  if ((state.checkpoint?.sequence ?? 0) < (saved?.checkpoint?.sequence ?? 0)) {
    return;
  }
  cache.delete(key);
  cache.set(key, state);
  if (cache.size > computersToKeep) {
    const keys = cache.keys();
    const oldest = keys.next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
}

function applyComputerEvent(state: ComputerState, row: StoredEvent) {
  state.checkpoint = row;
  const type = row.event.type;
  if (isComputerLifecycle(type)) state.latest = row;
  if (type === 'computer.claimed') state.claim = row;
}

async function readComputerState(store: EventStore, silo: string, subject: string,
  deadline: number) {
  const cache = computerCache(store);
  const key = JSON.stringify([silo, subject]);
  const previous = cache.get(key);
  const state = { ...previous };
  let pending = state.checkpoint;
  const from = pending?.sequence ?? 1;
  for await (const row of store.readStream(subject, from, deadline)) {
    if (row.event.silo !== silo) throw new WrongSiloError();
    if (pending) {
      // Confirm the last saved event before using the cached readiness and claim.
      if (row.sequence !== pending.sequence || row.event.id !== pending.event.id) break;
      pending = undefined;
    } else {
      applyComputerEvent(state, row);
    }
  }
  if (pending) {
    if (cache.get(key) === previous) {
      cache.delete(key);
    }
    throw new Error('Computer history changed');
  }
  keepComputerState(cache, key, state);
  return state;
}

async function currentComputer({ store, silo }: ViewAccessOptions, assistantId: string,
  deadline: number) {
  const subject = `computer-${assistantId}`;
  const lifecycle = await readComputerState(store, silo, subject, deadline);
  const latest = lifecycle.latest?.event;
  if (latest?.type !== 'computer.ready') {
    throw new Error('Computer unavailable');
  }
  const computer = ready.parse(latest.data);
  const claimed = computerIdentity.parse(lifecycle.claim?.event.data);
  if (computer.assistantId !== assistantId || computer.computerId !== claimed.computerId ||
      computer.generation !== claimed.generation) {
    throw new Error('Computer changed');
  }
  return computer;
}
