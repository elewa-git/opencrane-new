import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { toolApprovalRequestedDataSchema, type RoutineState } from '@opencrane/events';
import { envelope, history, readApproval, readRoutineApproval } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,300}$/u);
const inputSchema = z.strictObject({ routineId: id, occurrenceId: id,
  request: z.strictObject({ eventId: z.string().min(1).max(300), position: z.int().positive() }) });
type Input = z.infer<typeof inputSchema>;
const unchanged = { status: 'unchanged' as const };

// Validate a proposed expiry with the same reader as Stop, without saving it first.
// Limit every read to the captured log position; the proposed row exists only in this view.
function evidenceView(store: EventStore, through: number, proposed?: StoredEvent) {
  async function readEvent(position: number, deadline?: number) {
    if (proposed?.sequence === position) return proposed;
    if (position > through) throw new Error('Evidence outside snapshot');
    return store.readEvent(position, deadline);
  }
  async function* readStream(subject: string, from = 1, deadline?: number) {
    for await (const row of store.readStream(subject, from, deadline)) {
      if (row.sequence > through) break;
      yield row;
    }
    if (proposed?.event.subject === subject && proposed.sequence >= from) yield proposed;
  }
  function refuseAppend(): never { throw new Error('Read-only evidence'); }
  function get(target: EventStore, property: string | symbol) {
    if (property === 'readEvent') return readEvent;
    if (property === 'readStream') return readStream;
    if (property === 'append') return refuseAppend;
    const value: unknown = Reflect.get(target, property);
    return value;
  }
  return new Proxy(store, { get });
}

async function validate(store: EventStore, silo: string, input: Input,
  terminal: StoredEvent, deadline: number) {
  const rows = await history(store, `routine-${input.routineId}`, silo, deadline);
  let state: RoutineState | undefined;
  let claimPosition = 0;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of rows) {
    if (row.sequence >= terminal.sequence) break;
    state = foldRoutineHistory(state, row.event, completed);
    if (row.event.type === 'routine.due') claimPosition = row.sequence;
  }
  if (state?.activeRun?.occurrenceId !== input.occurrenceId) {
    throw new Error('Changed occurrence');
  }
  const cause = { eventId: terminal.event.id, position: terminal.sequence };
  await readRoutineApproval(store, state, cause, claimPosition, deadline);
}

async function inspect(store: EventStore, silo: string, input: Input, now: Date,
  deadline: number) {
  const through = await store.head(undefined, deadline);
  const snapshot = evidenceView(store, through);
  const requested = await snapshot.readEvent(input.request.position, deadline);
  const request = toolApprovalRequestedDataSchema.parse(requested.event.data);
  const subject = `approval-${request.approvalId}`;
  const rows = await history(snapshot, subject, silo, deadline);
  if (requested.event.type !== 'tool.approval_requested' || requested.event.silo !== silo ||
      requested.event.subject !== subject || requested.event.id !== input.request.eventId ||
      !isDeepStrictEqual(rows[0], requested)) {
    throw new Error('Changed request');
  }
  const current = await readApproval(snapshot, silo, request.approvalId,
    { now, deadline, deferInvalidation: true });
  if (current.state === 'expired' || current.state === 'denied') {
    const terminal = rows.at(-1)!;
    await validate(snapshot, silo, input, terminal, deadline);
    return { status: 'confirmed' as const, eventId: terminal.event.id, position: terminal.sequence };
  }
  if (current.invalidation?.type !== 'approval.expired') return unchanged;
  const event = envelope(silo, subject, 'approval.expired', { approvalId: request.approvalId },
    `routine-expiry-${requested.event.id}`, now);
  const proposed = { event, sequence: through + 1 };
  const proposedView = evidenceView(store, through, proposed);
  await validate(proposedView, silo, input, proposed, deadline);
  return { status: 'ready' as const, event, expectedSequence: current.sequence };
}

/** Expire one saved Ask internally. Stop and budget cleanup are separate commands. */
export async function expireRoutineApproval(store: EventStore, silo: string, raw: unknown,
  options: { enabled?: boolean; replay?: boolean; now?: () => Date } = {}) {
  if (options.enabled !== true || options.replay === true) return { status: 'disabled' as const };
  try {
    const input = inputSchema.parse(raw);
    const now = options.now?.() ?? new Date();
    const deadline = performance.now() + 10_000;
    const checked = await inspect(store, silo, input, now, deadline);
    if (checked.status !== 'ready') return checked;
    const command = { event: checked.event, expectedSequence: checked.expectedSequence,
      deadline: performance.now() + 2000, historyChecked: true as const };
    const result = await store.append(command);
    if (result.status === 'appended' && result.outcome?.kind === 'appended') {
      // Keep the acknowledged reference available for Stop even if later reads fail.
      // Require a new append; duplicate recovery does not prove this proposed event was saved.
      return {
        status: 'confirmed' as const,
        eventId: checked.event.id,
        position: result.sequence,
      };
    }
    if (result.status !== 'appended' && result.status !== 'conflict') {
      throw new Error('Expiry not saved');
    }
    // Read any competing decision or use. Never make a second append in this command.
    const saved = await inspect(store, silo, input, now, deadline);
    if (saved.status === 'ready') return unchanged;
    return saved;
  } catch {
    throw new Error('Routine approval expiry refused');
  }
}
