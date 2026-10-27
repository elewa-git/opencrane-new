import { readRoutineActivation } from './routine-activation.ts';

// Check saved identity only. Missing delivery evidence never proves that a send is safe.
export async function inspectRoutineSender(...args: Parameters<typeof readRoutineActivation>) {
  try {
    const checked = await readRoutineActivation(...args);
    const { receipt, messageId, turnId, rootId, senderAttemptId } = checked;
    return { status: 'unknown' as const, occurrenceId: receipt.occurrenceId,
      conversationId: receipt.conversationId, messageId, turnId, rootId, senderAttemptId,
      admission: { eventId: receipt.eventId, position: receipt.position },
      executionAvailable: false as const };
  } catch {
    throw new Error('Routine sender unavailable');
  }
}
