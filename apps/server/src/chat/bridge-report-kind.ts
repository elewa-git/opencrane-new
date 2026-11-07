import type { EventStore } from '@opencrane/event-store';
import { conversationCreatedDataSchema } from '@opencrane/events';
import { creationEvent } from './private-session.ts';

type ReportKind = { type: string; executionMode?: string | undefined;
  senderAttemptId?: string | undefined; conversationId: string };

export async function needsPrivateExit(store: Pick<EventStore, 'readStream'>, silo: string,
  report: ReportKind) {
  const terminal = report.type === 'agent.turn_completed' || report.type === 'agent.turn_failed';
  if (!terminal || report.executionMode !== 'restricted'
    || report.senderAttemptId !== undefined) return false;
  // Read only the creation record; routine preparation uses its own ending rules.
  const subject = `conversation-${report.conversationId}`;
  const created = await creationEvent(store, silo, subject, 'conversation.created');
  const session = conversationCreatedDataSchema.parse(created.data);
  return !('routinePreparation' in session && session.routinePreparation !== undefined);
}

export function isRoutineStartReport(report: ReportKind) {
  return report.type === 'agent.turn_started' && report.senderAttemptId !== undefined;
}
