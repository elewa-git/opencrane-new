import type { Duplex } from 'node:stream';
import type { connectMemberFeed } from '@opencrane/projections';
import { z } from 'zod';
import { grantStream, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
export interface ViewAccessOptions { silo: string; store: EventStore; binding: Binding; }

export interface LiveViewOptions extends ViewAccessOptions {
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
  control?: ((computer: { computerId: string; generation: number; podUid?: string | undefined }, action: 'pause' | 'resume', leaseId: string, version: number) => Promise<void>) | undefined;
  open(computer: { computerId: string; generation: number; podUid?: string | undefined }, writer?: boolean): Promise<Duplex>;
}

const identity = z.object({ assistantId: z.string() });
const ready = identity.extend({ computerId: z.string(), generation: z.int().positive(), podUid: z.string().optional() });
const participant = z.object({ participantId: z.string() });
const grant = z.object({ resourceType: z.string(), resourceId: z.string(), granteeId: z.string() });
const histories = new WeakMap<EventStore, Map<string, StoredEvent[]>>();

function saveHistory(cache: Map<string, StoredEvent[]>, key: string, rows: StoredEvent[]) {
  // Concurrent replies must not move the saved checkpoint backwards.
  if ((rows.at(-1)?.sequence ?? 0) < (cache.get(key)?.at(-1)?.sequence ?? 0)) return;
  // ponytail: keep 64 histories; use compact event projections if histories grow large.
  if (!cache.has(key) && cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, rows);
}

async function history(store: EventStore, subject: string, silo: string) {
  let cache = histories.get(store);
  if (!cache) { cache = new Map(); histories.set(store, cache); }
  const key = JSON.stringify([silo, subject]);
  const rows = [...(cache.get(key) ?? [])];
  const previous = rows.at(-1); let confirmed = !previous;
  // Confirm the saved checkpoint before reading its live tail.
  for await (const row of store.readStream(subject, previous?.sequence ?? 1)) {
    if (row.event.silo !== silo) throw new Error('Wrong silo');
    if (!confirmed) {
      if (row.sequence !== previous?.sequence || row.event.id !== previous?.event.id) break;
      rows[rows.length - 1] = row; confirmed = true;
    } else rows.push(row);
  }
  if (!confirmed) { cache.delete(key); throw new Error('Authority history changed'); }
  saveHistory(cache, key, rows);
  return rows;
}

/** Check authority as well as its projection: delayed revocations must fail closed. */
export async function viewAccess(options: ViewAccessOptions, memberId: string, conversationId: string) {
  const { store, silo } = options;
  if (options.binding.silo !== silo) throw new Error('Wrong silo');
  const [conversation, member] = await Promise.all([
    history(store, `conversation-${conversationId}`, silo), history(store, `member-${memberId}`, silo),
  ]);
  const created = conversation.find(r => r.event.type === 'conversation.created')?.event;
  if (!created || conversation.some(r => r.event.type === 'conversation.closed') ||
      member.at(-1)?.event.type === 'member.removed') throw new Error('Access changed');
  const assistantId = identity.parse(created.data).assistantId;
  if (!participatesIn(conversation, created.data, memberId)) throw new Error('Access changed');
  const computer = await currentComputer(options, assistantId);
  const grants = await history(store, grantStream('shared_desktop', computer.computerId), silo);
  const current = grants.findLast(r => {
    const data = grant.parse(r.event.data);
    return data.resourceType === 'shared_desktop' && data.resourceId === computer.computerId && data.granteeId === memberId;
  })?.event;
  if (current?.type !== 'grant.given' || z.object({ granteeKind: z.string() }).parse(current.data).granteeKind !== 'member') throw new Error('Desktop access required');
  const auth = memberAuthorisation(options.binding);
  const permissions = await Promise.all([auth.conversation(memberId, conversationId, 'read'), auth.desktop(memberId, computer.computerId)]);
  if (permissions.some(p => !p.allowed)) throw new Error('Access changed');
  return computer;
}

function participatesIn(conversation: StoredEvent[], data: unknown, memberId: string) {
  let participates = z.object({ createdBy: z.string() }).parse(data).createdBy === memberId;
  for (const { event } of conversation) {
    if (['participant.added', 'participant.removed'].includes(event.type) && participant.parse(event.data).participantId === memberId) {
      participates = event.type === 'participant.added';
    }
  }
  return participates;
}

async function currentComputer({ store, silo }: ViewAccessOptions, assistantId: string) {
  const lifecycle = await history(store, `computer-${assistantId}`, silo);
  const latest = lifecycle.findLast(r => !r.event.type.startsWith('computer.turn_') && !r.event.type.startsWith('takeover.'))?.event;
  if (latest?.type !== 'computer.ready') throw new Error('Computer unavailable');
  const computer = ready.parse(latest.data);
  const claimed = ready.parse(lifecycle.findLast(r => r.event.type === 'computer.claimed')?.event.data);
  if (computer.assistantId !== assistantId || computer.computerId !== claimed.computerId || computer.generation !== claimed.generation) throw new Error('Computer changed');
  return computer;
}
