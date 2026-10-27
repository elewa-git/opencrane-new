import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { foldRoutineHistory, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { routineStopSchema, type EventEnvelope, type RoutineState } from '@opencrane/events';
import { ownershipWriteAccess } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const revision = z.int().positive();
const inputSchema = z.strictObject({ routineId: id, occurrenceId: id,
  changeId: z.string().regex(/^[\w-]{1,200}:[\w-]{1,200}$/u),
  expectedPosition: z.int().nonnegative(), expectedDefinitionRevision: revision,
  expectedScheduleRevision: revision, expectedControlRevision: revision });
type Input = z.infer<typeof inputSchema>;
class StopConflict extends Error {
  constructor() {
    super('Routine Stop conflict');
  }
}
class StopRefused extends Error {
  constructor() {
    super('Routine Stop refused');
  }
}
function receipt(row: StoredEvent, changeId: string) {
  return { status: 'confirmed' as const, changeId, eventId: row.event.id, position: row.sequence };
}
function stopData(state: RoutineState | undefined, input: Input, position: number) {
  const saved = state?.definition;
  const run = state?.activeRun;
  if (!saved || !run) throw new StopRefused();
  if (position !== input.expectedPosition || run.occurrenceId !== input.occurrenceId ||
      saved.definitionRevision !== input.expectedDefinitionRevision ||
      saved.scheduleRevision !== input.expectedScheduleRevision ||
      saved.controlRevision !== input.expectedControlRevision) {
    throw new StopConflict();
  }
  // Retain the due's revisions and people even when a successor requests Stop.
  const data = { version: 1, routineId: run.routineId, occurrenceId: run.occurrenceId,
    rootId: run.rootId, conversationId: run.conversationId, messageId: run.messageId,
    turnId: run.turnId, definitionRevision: run.definitionRevision,
    scheduleRevision: run.scheduleRevision, controlRevision: run.controlRevision,
    actorId: saved.definition.ownerId, source: 'owner', reason: 'owner_requested',
    affectedRun: run.occurrenceId, next: saved.next };
  return routineStopSchema.parse(data);
}
function requireSame(row: StoredEvent, input: Input, memberId: string,
  data: ReturnType<typeof stopData>) {
  const event = row.event;
  const saved = routineStopSchema.safeParse(event.data);
  if (event.type !== 'routine.run_stop_requested' || event.commandId !== input.changeId ||
      event.subject !== `routine-${input.routineId}` || event.principal?.kind !== 'human' ||
      event.principal.id !== memberId || data.actorId !== memberId ||
      !saved.success || !isDeepStrictEqual(saved.data, data)) {
    throw new StopConflict();
  }
}
function previousStop(rows: StoredEvent[], input: Input, memberId: string) {
  let state: RoutineState | undefined;
  let position = 0;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of rows) {
    if (row.event.commandId === input.changeId) {
      requireSame(row, input, memberId, stopData(state, input, position));
      return receipt(row, input.changeId);
    }
    state = foldRoutineHistory(state, row.event, completed);
    position = row.sequence;
  }
  return undefined;
}

async function ownerAccess(store: EventStore, binding: Binding,
  memberId: string, routineId: string) {
  const auth = memberAuthorisation(binding, store);
  let saved;
  try {
    saved = await auth.loadRoutineAccess(memberId, routineId);
  } catch {
    throw new StopRefused();
  }
  const permission = await saved.check('read_metadata');
  // Refuse every non-owner before exposing conflicts or an earlier receipt.
  if (!permission.allowed || saved.state?.definition?.definition.ownerId !== memberId) {
    throw new StopRefused();
  }
  return saved;
}

/** Save intent only; budget cleanup is a separate recoverable operation. */
export async function requestRoutineStop(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  try {
    const input = inputSchema.parse(raw);
    const saved = await ownerAccess(store, binding, memberId, input.routineId);
    if (!input.changeId.startsWith(`${input.routineId}:`)) throw new StopConflict();
    const previous = previousStop(saved.rows, input, memberId);
    if (previous) return previous;
    const position = saved.rows.at(-1)?.sequence ?? 0;
    const data = stopData(saved.state, input, position);
    const event: EventEnvelope = { id: randomUUID(), commandId: input.changeId,
      type: 'routine.run_stop_requested', source: 'opencrane-server', silo: binding.silo,
      subject: `routine-${input.routineId}`, principal: { kind: 'human', id: data.actorId },
      time: new Date().toISOString(), correlation: {}, data };
    // Finish history before watching only the small membership and ownership streams.
    const fresh = await ownershipWriteAccess(store, saved.positions);
    if (!(await saved.check('read_metadata')).allowed) throw new StopRefused();
    const change = { event, expectedSequence: position, deadline: fresh.deadline,
      historyChecked: true as const, checkAccess: fresh };
    const result = await store.append(change);
    if (result.status === 'conflict' || result.status === 'rejected') throw new StopConflict();
    if (result.status !== 'appended') throw new Error('Append unavailable');
    const row = await store.readEvent(result.sequence, performance.now() + 10_000);
    requireSame(row, input, memberId, data);
    return receipt(row, input.changeId);
  } catch (error) {
    if (error instanceof StopConflict || error instanceof StopRefused) throw error;
    // eslint-disable-next-line preserve-caught-error -- Keep private service details out of replies.
    throw new Error('Routine Stop unavailable');
  }
}
