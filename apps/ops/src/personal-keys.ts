import type { EventStore } from '@opencrane/event-store';
import { memberJoinedDataSchema, siloOwnerBootstrappedDataSchema, parseEventByType,
  type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { currentMembership } from '@opencrane/models';
import type { conversationKeys } from '@opencrane/projections';

const membershipData = memberJoinedDataSchema.or(siloOwnerBootstrappedDataSchema);
export function personalKeyHandler(store: Pick<EventStore, 'readStream'>,
  keys: ReturnType<typeof conversationKeys>) {
  async function preparePersonalKey(event: EventEnvelope): Promise<void> {
    if (!parseEventByType(event).success) {
      throw new Error('Invalid membership event');
    }
    const fields = membershipData.parse(event.data);
    if (event.subject !== `member-${fields.memberId}`) {
      throw new Error('Invalid member subject');
    }
    // Check current membership before handling an old join. Never restore access or an assistant.
    const membership = await currentMembership(store, event.silo, fields.memberId,
      undefined, performance.now() + 10_000);
    if (!membership.role) {
      return;
    }
    keys.provision(event.silo, `personal:${fields.memberId}`);
  }
  return registerHandler('prepare-personal-key', preparePersonalKey);
}
