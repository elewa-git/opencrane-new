import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { foldRoutineHistory, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { legacyMemberRole, getEventDefinition, type EventEnvelope,
  type RoutineState } from '@opencrane/events';
import { history, ownershipWriteAccess, readActiveMember } from '@opencrane/models';
import { sharedAssistantAuthority } from './chat/private-session.ts';

const reassignmentSchema = getEventDefinition('routine.reassigned')!.dataSchema;
const id = z.string().regex(/^[\w-]{1,200}$/u);
const revision = z.int().positive();
const inputSchema = z.strictObject({
  changeId: z.string().regex(/^[\w-]{1,200}:[\w-]{1,200}$/u), routineId: id,
  ownerId: id, expectedPosition: z.int().nonnegative(), expectedDefinitionRevision: revision,
  expectedScheduleRevision: revision, expectedControlRevision: revision,
});
type Input = z.infer<typeof inputSchema>;
class ReassignmentConflict extends Error {
  constructor() {
    super('Routine reassignment conflict');
  }
}
class ReassignmentRefused extends Error {
  constructor() {
    super('Routine reassignment refused');
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
    throw new ReassignmentConflict();
  }
}

function reassignmentData(state: RoutineState | undefined, memberId: string,
  ownerId: string, ownerAdmissionId: string) {
  const saved = state?.definition;
  if (!saved || state.status !== 'paused' || state.activeRun ||
      saved.definition.ownerId === ownerId) {
    throw new ReassignmentRefused();
  }
  const data = { version: 1, routineId: state.routineId,
    definitionRevision: saved.definitionRevision + 1, scheduleRevision: saved.scheduleRevision,
    controlRevision: saved.controlRevision + 1, actorId: memberId,
    source: 'admin', reason: 'admin_requested',
    affectedRun: null, next: saved.next,
    definition: { ...saved.definition, ownerId, ownerAdmissionId } };
  reassignmentSchema.parse(data);
  return data;
}

function requireSameReassignment(event: EventEnvelope, input: Input, memberId: string,
  data: ReturnType<typeof reassignmentData>) {
  const saved = reassignmentSchema.safeParse(event.data);
  if (event.type !== 'routine.reassigned' || event.commandId !== input.changeId ||
      event.subject !== `routine-${input.routineId}` ||
      event.principal?.kind !== 'human' || event.principal.id !== memberId ||
      !saved.success || !isDeepStrictEqual(saved.data, data)) {
    throw new ReassignmentConflict();
  }
}

function previousReassignment(rows: StoredEvent[], input: Input, memberId: string,
  admissionId: string) {
  let state: RoutineState | undefined;
  let position = 0;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for (const row of rows) {
    if (row.event.commandId === input.changeId) {
      requireRevisions(input, state, position);
      const data = reassignmentData(state, memberId, input.ownerId, admissionId);
      requireSameReassignment(row.event, input, memberId, data);
      return receipt(row, input.changeId);
    }
    state = foldRoutineHistory(state, row.event, completed);
    position = row.sequence;
  }
  return undefined;
}

async function requireAdmin(store: EventStore, binding: Binding, memberId: string) {
  try {
    await readActiveMember(store, binding, memberId, 'admin');
  } catch {
    throw new ReassignmentRefused();
  }
}

const assistantSchema = z.object({ kind: z.literal('team'), payingGroupId: z.string() });
const settingsSchema = z.object({ active: z.boolean().optional() });

async function recipient(store: EventStore, binding: Binding, ownerId: string,
  definition: NonNullable<RoutineState['definition']>['definition']) {
  const deadline = performance.now() + 10_000;
  const members = await history(store, `member-${ownerId}`, binding.silo, deadline);
  let role = '';
  let admissionId: string | undefined;
  for (const row of members) {
    role = legacyMemberRole(row.event) ?? role;
    if (row.event.type === 'member.joined' || row.event.type === 'silo.owner_bootstrapped') {
      admissionId = row.event.id;
    }
  }
  // Keep saved removal decisive before reading another dependency.
  if (!role || !admissionId) throw new ReassignmentRefused();
  const subject = `assistant-${definition.assistantId}`;
  const assistants = await history(store, subject, binding.silo, deadline);
  const created = assistants[0]?.event;
  if (created?.type !== 'assistant.created') throw new ReassignmentRefused();
  const assistant = assistantSchema.parse(created.data);
  let active = true;
  for (const row of assistants) {
    if (row.event.type === 'assistant.settings_changed') {
      active = settingsSchema.parse(row.event.data).active ?? active;
    }
  }
  if (!active || assistant.payingGroupId !== definition.payingGroupId) {
    throw new ReassignmentRefused();
  }
  const positions = new Map<string, number>();
  positions.set(`member-${ownerId}`, members.at(-1)!.sequence);
  positions.set(subject, assistants.at(-1)!.sequence);
  return { admissionId, positions };
}

async function reassignmentAccess(store: EventStore, binding: Binding,
  memberId: string, input: Input) {
  // Keep admin refusals decisive before preparing routine access can fail.
  await requireAdmin(store, binding, memberId);
  const auth = memberAuthorisation(binding, store);
  const saved = await auth.loadRoutineAccess(memberId, input.routineId);
  // Check metadata and the separate admin role before revealing conflicts or receipts.
  if (!(await saved.check('read_metadata')).allowed) {
    throw new ReassignmentRefused();
  }
  const state = saved.state;
  const definition = state?.definition;
  if (!state || !definition || state.status !== 'paused' || state.activeRun) {
    throw new ReassignmentRefused();
  }
  let successor: Awaited<ReturnType<typeof recipient>>;
  try {
    successor = await recipient(store, binding, input.ownerId, definition.definition);
  } catch {
    throw new ReassignmentRefused();
  }
  const positions = new Map(saved.positions);
  for (const [subject, position] of successor.positions) {
    const earlier = positions.get(subject);
    if (earlier !== undefined && earlier !== position) throw new ReassignmentRefused();
    positions.set(subject, position);
  }
  // Finish routine history before starting the original two-second access limit.
  const fresh = await ownershipWriteAccess(store, positions);
  const options = { silo: binding.silo, store, binding };
  try {
    await sharedAssistantAuthority(options, input.ownerId, definition.definition.assistantId,
      definition.definition.payingGroupId, fresh);
  } catch {
    throw new ReassignmentRefused();
  }
  if (!(await saved.check('read_metadata')).allowed ||
      !(await auth.check(memberId, 'admin')).allowed) {
    throw new ReassignmentRefused();
  }
  await fresh();
  return { saved, successor, fresh };
}

/** Change only the owner of paused work after its occupied run has ended. */
export async function reassignRoutine(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  try {
    const input = inputSchema.parse(raw);
    const { saved, successor, fresh } = await reassignmentAccess(store, binding, memberId, input);
    // Check recipient authority too before revealing saved receipts or conflicts.
    if (!input.changeId.startsWith(`${input.routineId}:`)) throw new ReassignmentConflict();
    const previous = previousReassignment(saved.rows, input, memberId, successor.admissionId);
    if (previous) return previous;
    const data = reassignmentData(saved.state, memberId, input.ownerId, successor.admissionId);
    const position = saved.rows.at(-1)?.sequence ?? 0;
    requireRevisions(input, saved.state, position);
    const event: EventEnvelope = { id: randomUUID(), commandId: input.changeId,
      type: 'routine.reassigned', source: 'opencrane-server', silo: binding.silo,
      subject: `routine-${input.routineId}`, principal: { kind: 'human', id: data.actorId },
      time: new Date().toISOString(), correlation: {}, data };
    const change = { event, expectedSequence: position, deadline: fresh.deadline,
      historyChecked: true as const, checkAccess: fresh };
    const result = await store.append(change);
    if (result.status === 'conflict' || result.status === 'rejected') {
      throw new ReassignmentConflict();
    }
    if (result.status !== 'appended') {
      throw new Error('Append unavailable');
    }
    // Compare the saved change because a concurrent request may have used this id first.
    const row = await store.readEvent(result.sequence, performance.now() + 10_000);
    requireSameReassignment(row.event, input, memberId, data);
    return receipt(row, input.changeId);
  } catch (error) {
    if (error instanceof ReassignmentConflict || error instanceof ReassignmentRefused) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- Keep private service details out of replies.
    throw new Error('Routine reassignment unavailable');
  }
}
