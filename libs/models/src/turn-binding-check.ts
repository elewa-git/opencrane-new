import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';

type SignedTurn = {
  thread: string;
  conversation: string;
  requester: string;
  task: string;
  providerId?: string | undefined;
  bindingSequence?: number | undefined;
  model: string;
  sharingClass?: 'shared_only' | undefined;
};

const eventDataSchema = z.record(z.string(), z.unknown());

export function requireRecordedActiveTurn(turnToken: SignedTurn,
  turn: StoredEvent | undefined, firstClose: unknown) {
  if (!turn || firstClose || turn.event.source !== 'opencrane-server') {
    throw new Error('Turn is not active');
  }
  const recorded = eventDataSchema.parse(turn.event.data);
  if (recorded['threadId'] !== turnToken.thread ||
      recorded['conversationId'] !== turnToken.conversation ||
      recorded['requesterId'] !== turnToken.requester || recorded['task'] !== turnToken.task ||
      recorded['providerId'] !== turnToken.providerId ||
      recorded['bindingSequence'] !== turnToken.bindingSequence ||
      recorded['sharingClass'] !== turnToken.sharingClass ||
      (recorded['model'] !== undefined && recorded['model'] !== turnToken.model)) {
    throw new Error('Turn is not active');
  }
  return turn;
}

export function requireTurnDelegation(turnToken: {
  task: string;
  delegation: string[];
  requester: string;
}) {
  if (turnToken.task === 'native_descendant') throw new Error('Native delegation is disabled');
  if (turnToken.delegation[0] !== turnToken.requester) throw new Error('Delegation refused');
}

export function requireCurrentComputer(computer: StoredEvent | undefined, sequence: number) {
  // Check the same ready event that supplied the pass. Refuse a change between the two reads.
  if (computer?.event.type !== 'computer.ready' || computer.sequence !== sequence) {
    throw new Error('Computer changed');
  }
}

export function requireSharedTurnTools(sharingClass: 'shared_only' | undefined) {
  if (sharingClass === 'shared_only') throw new Error('Shared turns have no tools');
}
