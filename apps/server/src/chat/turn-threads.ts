import type { ThreadSummary } from '@opencrane/auth';
import type { SessionConfiguration } from '@opencrane/events';
import { ReportRejected } from './reports.ts';
import { TurnAdmissionRejected } from './turn-authority.ts';

type ThreadBinding = {
  threadId?: string | undefined;
  turnId: string;
  requesterId: string;
  conversationId: string;
};

export function requireThreadOwner(threads: Map<string, ThreadSummary>, input: ThreadBinding) {
  if (input.threadId === undefined) {
    return;
  }
  const thread = threads.get(input.threadId);
  const owner = JSON.stringify([input.requesterId, input.conversationId]);
  if (thread && hasOtherValue(thread.owners, owner)) {
    throw new ReportRejected('Thread belongs to another requester or conversation');
  }
}
function hasOtherValue(values: Set<string>, current: string) {
  for (const value of values) {
    if (value !== current) {
      return true;
    }
  }
  return false;
}

export function requireFreshPrivateThread(threads: Map<string, ThreadSummary>, input: ThreadBinding,
  configuration: Pick<SessionConfiguration, 'process'>) {
  if (input.threadId === undefined) {
    return;
  }
  const thread = threads.get(input.threadId);
  if (!thread) {
    return;
  }
  const otherStarted = hasOtherValue(thread.startedTurnIds, input.turnId);
  const otherRestricted = hasOtherValue(thread.restrictedTurnIds, input.turnId);
  if ((configuration.process === 'fresh_isolated' && otherStarted) || otherRestricted) {
    throw new TurnAdmissionRejected('Private thread reused');
  }
}
