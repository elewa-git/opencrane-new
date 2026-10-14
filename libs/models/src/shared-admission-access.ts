import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { conversationEventId } from '@opencrane/events';
import { conversationParticipation } from './conversation.ts';
import { history } from './actor.ts';
import { data } from './state.ts';

type Participation = ReturnType<typeof conversationParticipation>;

function applyParticipation(access: Participation, row: StoredEvent) {
  const type = row.event.type;
  if (type !== 'participant.added' && type !== 'participant.removed') {
    return;
  }
  if (conversationEventId(row.event) !== access.created.conversationId) {
    throw new Error('Shared participation refused');
  }
  const participantId = data(row.event)['participantId'];
  if (typeof participantId !== 'string') {
    throw new Error('Shared participation refused');
  }
  if (type === 'participant.removed') {
    access.joins.delete(participantId);
  } else if (!access.joins.has(participantId)) {
    access.joins.set(participantId, row);
  }
}

function requireSharedParticipation(child: Participation, parent: Participation,
  requesterId: string, creatorActive: boolean) {
  const created = child.created;
  if (!('contextKind' in created)) {
    throw new Error('Shared child required');
  }
  const join = child.joins.get(requesterId);
  if (!join) {
    throw new Error('Shared participation refused');
  }
  if (join.event.type === 'participant.added') {
    const fields = data(join.event);
    if (fields['contextKind'] !== 'shared_child' || fields['joinKind'] !== 'explicit_child') {
      throw new Error('Shared participation refused');
    }
    return;
  }
  if (!creatorActive) {
    throw new Error('Shared participation refused');
  }
  const initialJoins = created.initialJoins;
  const members = new Set([requesterId, created.createdBy]);
  for (const memberId of members) {
    function matchesMember(record: (typeof initialJoins)[number]) {
      return record.participantId === memberId;
    }
    const recorded = initialJoins.find(matchesMember);
    const current = parent.joins.get(memberId);
    if (!recorded || current?.event.id !== recorded.parentJoinEventId ||
        current.sequence !== recorded.parentJoinPosition) {
      throw new Error('Shared participation refused');
    }
  }
}

/** Read shared access before the short authority check, then read only later changes. */
export async function sharedAdmissionAccess(store: EventStore, silo: string,
  conversation: StoredEvent[], requesterId: string, deadline: number) {
  function isCreation(row: StoredEvent) {
    return row.event.type === 'conversation.created';
  }
  const creation = conversation.find(isCreation);
  if (!creation) {
    throw new Error('Shared child required');
  }
  const child = conversationParticipation(creation);
  const created = child.created;
  if (!('contextKind' in created)) {
    throw new Error('Shared child required');
  }
  const parentSubject = `conversation-${created.origin.parentConversationId}`;
  const parentRows = await history(store, parentSubject, silo, deadline);
  const parentCreation = parentRows.find(isCreation);
  if (!parentCreation) {
    throw new Error('Shared participation refused');
  }
  const parent = conversationParticipation(parentCreation);
  for (const row of parentRows) {
    applyParticipation(parent, row);
  }
  for (const row of conversation) {
    applyParticipation(child, row);
  }
  const positions = new Map<string, number>();
  function isParentRow(row: StoredEvent) {
    return row.event.subject === parentSubject;
  }
  // Keep a participation-stream close out of the conversation stream's read position.
  const lastParentRow = parentRows.findLast(isParentRow)!;
  positions.set(parentSubject, lastParentRow.sequence);
  positions.set(creation.event.subject, conversation.at(-1)!.sequence);
  const parentAccessSubject = `participation-${created.origin.parentConversationId}`;
  const childAccessSubject = `participation-${created.conversationId}`;
  const creatorSubject = `member-${created.createdBy}`;
  const subjects = [parentSubject, creation.event.subject, parentAccessSubject,
    childAccessSubject, creatorSubject];
  let creatorActive = false;
  async function confirm(readDeadline: number) {
    let changed = false;
    for (const subject of subjects) {
      const from = (positions.get(subject) ?? 0) + 1;
      const to = await store.head(subject, readDeadline);
      if (to < from - 1) {
        throw new Error('Shared participation refused');
      }
      if (to < from) continue;
      for await (const row of store.readStream(subject, from, readDeadline)) {
        if (row.sequence > to) break;
        if (row.event.silo !== silo) {
          throw new Error('Shared participation refused');
        }
        if (subject === creatorSubject) {
          if (['member.joined', 'silo.owner_bootstrapped'].includes(row.event.type)) {
            creatorActive = true;
          }
          if (row.event.type === 'member.removed') creatorActive = false;
        } else if (subject === parentSubject || subject === parentAccessSubject) {
          applyParticipation(parent, row);
        } else {
          if (row.event.type === 'conversation.closed') {
            throw new Error('Root is not active');
          }
          applyParticipation(child, row);
        }
      }
      positions.set(subject, to);
      changed = true;
    }
    requireSharedParticipation(child, parent, requesterId, creatorActive);
    return changed;
  }
  await confirm(deadline);
  return confirm;
}
