import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { history } from '@opencrane/models';
export interface ViewAccessOptions { silo: string; store: EventStore; binding: Binding; }

const identity = z.object({ assistantId: z.string() });
const ready = identity.extend({ computerId: z.string(), generation: z.int().positive(), podUid: z.string().optional() });
const participant = z.object({ participantId: z.string() });
const grant = z.object({ resourceType: z.string(), resourceId: z.string(), granteeId: z.string() });

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
  const grants = await history(store, `grant-${computer.computerId}`, silo);
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
  const latest = lifecycle.findLast(r => !r.event.type.startsWith('computer.turn_'))?.event;
  if (latest?.type !== 'computer.ready') throw new Error('Computer unavailable');
  const computer = ready.parse(latest.data);
  const claimed = ready.parse(lifecycle.findLast(r => r.event.type === 'computer.claimed')?.event.data);
  if (computer.assistantId !== assistantId || computer.computerId !== claimed.computerId || computer.generation !== claimed.generation) throw new Error('Computer changed');
  return computer;
}
