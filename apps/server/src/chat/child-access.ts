import { parseEventByType } from '@opencrane/events';
import { z } from 'zod';

import { legacyParticipation, participation, chatMembership, ParticipationRefused }
  from './participation.ts';
import type { EventStore } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';

const explicitJoin = z.object({
  contextKind: z.literal('shared_child'), joinKind: z.literal('explicit_child'),
});

type Options = { store: EventStore; db: Query; silo: string };
type Participation = Awaited<ReturnType<typeof participation>>;

export function inheritedChildSubjects(access: Participation) {
  const created = access.created;
  if (!('contextKind' in created)) return [];
  if (access.joinEventId !== access.creation.event.id) {
    const parsed = parseEventByType(access.join.event);
    if (!parsed.success || access.join.event.type !== 'participant.added' ||
        !explicitJoin.safeParse(parsed.event.data).success) {
      throw new ParticipationRefused('Conversation refused');
    }
    return [];
  }
  return [`participation-${created.origin.parentConversationId}`, `member-${created.createdBy}`];
}

// Keep inherited access tied to the original joins. Rejoining cannot restore them.
export async function requireInheritedChildAccess(options: Options,
  access: Participation, readerId: string, deadline: number) {
  const subjects = inheritedChildSubjects(access);
  const created = access.created;
  if (!subjects.length || !('contextKind' in created)) return;
  if (!await chatMembership(options.store, options.silo, created.createdBy, deadline)) {
    throw new ParticipationRefused('Conversation refused');
  }
  const parentId = created.origin.parentConversationId;
  const legacy = await legacyParticipation(options.store, options.db, options.silo,
    parentId, deadline);
  const memberIds = new Set([readerId, created.createdBy]);
  const initialJoins = created.initialJoins;
  for (const memberId of memberIds) {
    function isRecorded(join: (typeof initialJoins)[number]) {
      return join.participantId === memberId;
    }
    const recorded = initialJoins.find(isRecorded);
    const parent = await participation(options.store, options.silo, parentId,
      memberId, legacy, deadline);
    if (!recorded || parent.joinEventId !== recorded.parentJoinEventId ||
        parent.joinPosition !== recorded.parentJoinPosition) {
      throw new ParticipationRefused('Conversation refused');
    }
  }
}
