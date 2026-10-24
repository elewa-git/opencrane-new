import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { foldRoutine, routineControlSchema, type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import { ownershipWriteAccess } from '@opencrane/models';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const revision = z.int().positive();
const inputSchema = z.strictObject({
  changeId: z.string().regex(/^[\w-]{1,200}:[\w-]{1,200}$/u), routineId: id,
  expectedPosition: z.int().nonnegative(), expectedDefinitionRevision: revision,
  expectedScheduleRevision: revision, expectedControlRevision: revision,
});
type Input = z.infer<typeof inputSchema>;
type RoutineAccess = Awaited<ReturnType<ReturnType<typeof memberAuthorisation>['loadRoutineAccess']>>;
class RetirementConflict extends Error {
  constructor() {
    super('Routine retirement conflict');
  }
}
class RetirementRefused extends Error {
  constructor() {
    super('Routine retirement refused');
  }
}

function receipt(row: StoredEvent, changeId: string) {
  return { status: 'confirmed' as const, changeId, eventId: row.event.id,
    position: row.sequence };
}

function requireRevisions(input: Input, state: RoutineState | undefined, position: number) {
  const saved = state?.definition;
  if (!saved || input.expectedPosition !== position ||
      input.expectedDefinitionRevision !== saved.definitionRevision ||
      input.expectedScheduleRevision !== saved.scheduleRevision ||
      input.expectedControlRevision !== saved.controlRevision) {
    throw new RetirementConflict();
  }
}

function retirementData(state: RoutineState | undefined) {
  const saved = state?.definition;
  if (!saved || state.status === 'retired' || state.activeRun) {
    throw new RetirementRefused();
  }
  const data = { version: 1, routineId: state.routineId,
    definitionRevision: saved.definitionRevision, scheduleRevision: saved.scheduleRevision,
    controlRevision: saved.controlRevision + 1, actorId: saved.definition.ownerId,
    source: 'owner', reason: 'owner_requested', affectedRun: null, next: null };
  return routineControlSchema.parse(data);
}

function requireSameRetirement(event: EventEnvelope, input: Input, memberId: string,
  data: ReturnType<typeof retirementData>) {
  const saved = routineControlSchema.safeParse(event.data);
  if (event.type !== 'routine.retired' || event.commandId !== input.changeId ||
      event.subject !== `routine-${input.routineId}` ||
      event.principal?.kind !== 'human' || event.principal.id !== memberId ||
      data.actorId !== memberId ||
      !saved.success || JSON.stringify(saved.data) !== JSON.stringify(data)) {
    throw new RetirementConflict();
  }
}

function previousRetirement(rows: StoredEvent[], input: Input, memberId: string) {
  let state: RoutineState | undefined;
  let position = 0;
  for (const row of rows) {
    if (row.event.commandId === input.changeId) {
      requireRevisions(input, state, position);
      requireSameRetirement(row.event, input, memberId, retirementData(state));
      return receipt(row, input.changeId);
    }
    state = foldRoutine(state, row.event);
    position = row.sequence;
  }
  return undefined;
}

async function requireMetadataAccess(saved: RoutineAccess) {
  const permission = await saved.check('read_metadata');
  if ('reason' in permission && permission.reason === 'history_unavailable') {
    // Report broken history only after the permission service confirms read access.
    throw new Error('Routine history unavailable');
  }
  if (!permission.allowed) {
    throw new RetirementRefused();
  }
}

/** Save only the owner's retirement; active runs need the later Stop operation. */
export async function retireRoutine(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  try {
    const input = inputSchema.parse(raw);
    // Bind the reference to its target even after the transport forgets duplicate ids.
    if (!input.changeId.startsWith(`${input.routineId}:`)) {
      throw new RetirementConflict();
    }
    const auth = memberAuthorisation(binding, store);
    const saved = await auth.loadRoutineAccess(memberId, input.routineId);
    // Check metadata access before revealing saved changes or revision conflicts.
    await requireMetadataAccess(saved);
    const previous = previousRetirement(saved.rows, input, memberId);
    if (previous) {
      return previous;
    }
    const data = retirementData(saved.state);
    if (data.actorId !== memberId) {
      throw new RetirementRefused();
    }
    const position = saved.rows.at(-1)?.sequence ?? 0;
    requireRevisions(input, saved.state, position);
    const event: EventEnvelope = { id: randomUUID(), commandId: input.changeId,
      type: 'routine.retired', source: 'opencrane-server', silo: binding.silo,
      subject: `routine-${input.routineId}`, principal: { kind: 'human', id: data.actorId },
      time: new Date().toISOString(), correlation: {}, data };
    // Finish history reads before starting the original two-second access limit.
    const fresh = await ownershipWriteAccess(store, saved.positions);
    if (!(await saved.check('manage')).allowed) {
      throw new RetirementRefused();
    }
    const change = { event, expectedSequence: position, deadline: fresh.deadline,
      historyChecked: true as const, checkAccess: fresh };
    const result = await store.append(change);
    if (result.status === 'conflict' || result.status === 'rejected') {
      throw new RetirementConflict();
    }
    if (result.status !== 'appended') {
      throw new Error('Append unavailable');
    }
    // Compare the saved change because a concurrent request may have used this id first.
    const row = await store.readEvent(result.sequence, performance.now() + 10_000);
    requireSameRetirement(row.event, input, memberId, data);
    return receipt(row, input.changeId);
  } catch (error) {
    if (error instanceof RetirementConflict || error instanceof RetirementRefused) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- Keep private service details out of replies.
    throw new Error('Routine retirement unavailable');
  }
}
