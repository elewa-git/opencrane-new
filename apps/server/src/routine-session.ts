import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { foldRoutineHistory, memberAuthorisation, type Binding } from '@opencrane/authz';
import type { AppendCommand, EventStore, StoredEvent } from '@opencrane/event-store';
import { parseEventByType, type RoutineState } from '@opencrane/events';
import { currentAuthority, currentMembership, history, ownershipWriteAccess } from '@opencrane/models';
import { chatCommand } from './chat/commands.ts';
import type { conversationKeys } from './chat/keys.ts';
import { sharedAssistantAuthority } from './chat/private-session.ts';

type Run = NonNullable<RoutineState['activeRun']>;
interface Worker {
  silo: string;
  binding: Binding;
  workerId: string;
  // Supply current ownership from the trusted worker, never from saved records or a request.
  checkCurrent: (deadline: number) => Promise<boolean>;
  now?: () => number;
}
const inputSchema = z.strictObject({ routineId: z.string().regex(/^[\w-]{1,200}$/u),
  occurrenceId: z.string().regex(/^[\w-]{1,300}$/u) });
const assistantSchema = z.object({ kind: z.literal('team'), payingGroupId: z.string() });
const settingsSchema = z.object({ active: z.boolean().optional() });

function requireRun(state: RoutineState | undefined, occurrenceId: string) {
  const run = state?.activeRun;
  const saved = state?.definition;
  if (!run || !saved || state.status !== 'active' || state.stopRequested || state.activation ||
      run.occurrenceId !== occurrenceId ||
      saved.definitionRevision !== run.definitionRevision ||
      saved.scheduleRevision !== run.scheduleRevision ||
      saved.controlRevision !== run.controlRevision ||
      !isDeepStrictEqual(saved.definition, run.definition) ||
      run.conversationId !== `routine-session-${occurrenceId}` ||
      Date.parse(run.startBy) !== Date.parse(run.firedAt) + 60_000) {
    throw new Error('Routine session refused');
  }
  return run;
}

function foldPreparation(rows: StoredEvent[], occurrenceId: string) {
  let state: RoutineState | undefined;
  let claim: StoredEvent | undefined;
  const completed = new Map<string, Run>();
  for (const row of rows) {
    state = foldRoutineHistory(state, row.event, completed);
    if (row.event.type === 'routine.due' && state?.activeRun?.occurrenceId === occurrenceId) {
      claim = row;
    }
  }
  const run = requireRun(state, occurrenceId);
  if (!claim || !isDeepStrictEqual(claim.event.data, run)) {
    throw new Error('Routine session refused');
  }
  return { state, completed, claim, run };
}

async function loadPreparation(store: EventStore, worker: Worker,
  input: z.infer<typeof inputSchema>) {
  if (worker.binding.silo !== worker.silo) {
    throw new Error('Routine session refused');
  }
  const deadline = performance.now() + 10_000;
  const rows = await history(store, `routine-${input.routineId}`, worker.silo, deadline);
  if (rows[0]?.event.type !== 'routine.created') {
    throw new Error('Routine session refused');
  }
  const { state, completed, claim, run } = foldPreparation(rows, input.occurrenceId);
  const ownerId = run.definition.ownerId;
  const auth = memberAuthorisation(worker.binding, store);
  const access = await auth.loadRoutineAccess(ownerId, input.routineId);
  if (access.rows.at(-1)?.sequence !== rows.at(-1)?.sequence) {
    throw new Error('Routine session refused');
  }
  const member = await loadOwnerMembership(store, worker, run);
  const assistantSubject = `assistant-${run.definition.assistantId}`;
  const assistantPosition = await loadAssistantPosition(store, worker, run);
  const positions = new Map(member.positions);
  positions.set(assistantSubject, assistantPosition);
  for (const [subject, position] of access.positions) {
    if (positions.get(subject) !== position) {
      throw new Error('Routine session refused');
    }
  }
  return { run, claim, state, completed, access, positions, position: rows.at(-1)!.sequence };
}

async function loadOwnerMembership(store: EventStore, worker: Worker, run: Run) {
  const member = await currentMembership(store, worker.silo, run.definition.ownerId, undefined,
    performance.now() + 10_000);
  let admissionId: string | undefined;
  for (const row of member.facts) {
    if (row.event.type === 'member.joined' || row.event.type === 'silo.owner_bootstrapped') {
      admissionId = row.event.id;
    }
  }
  if (!member.role || admissionId !== run.definition.ownerAdmissionId) {
    throw new Error('Routine session refused');
  }
  return member;
}

async function loadAssistantPosition(store: EventStore, worker: Worker, run: Run) {
  const assistantSubject = `assistant-${run.definition.assistantId}`;
  const assistantRows = await history(store, assistantSubject, worker.silo,
    performance.now() + 10_000);
  const creation = assistantRows[0]?.event;
  if (creation?.type !== 'assistant.created') {
    throw new Error('Routine session refused');
  }
  const assistant = assistantSchema.parse(creation.data);
  let active = true;
  for (const row of assistantRows) {
    if (row.event.type === 'assistant.settings_changed') {
      active = settingsSchema.parse(row.event.data).active ?? active;
    }
  }
  if (!active || assistant.payingGroupId !== run.definition.payingGroupId) {
    throw new Error('Routine session refused');
  }
  return assistantRows.at(-1)!.sequence;
}

/** Prepare only the private session. A receipt never authorises input or execution. */
export async function prepareRoutineSession(store: EventStore,
  keys: ReturnType<typeof conversationKeys>, worker: Worker, raw: unknown) {
  try {
    const saved = await loadRoutinePreparation(store, keys, worker, raw);
    let attemptedAppend = false;
    async function append(change: AppendCommand) {
      attemptedAppend = true;
      const parsed = parseEventByType(change.event);
      if (!parsed.success) throw new Error('Routine session refused');
      // Add the binding only after the trusted worker and current claim have been checked.
      const event = { ...parsed.event, data: saved.expectedCreation };
      const checked = { ...change, event, checkAccess: saved.checkCurrent };
      return store.append(checked);
    }
    const guarded = { readStream: saved.readStream, append };
    const result = await chatCommand(guarded, keys, saved.context,
      saved.command, saved.checkFresh);
    if (result.status !== 'appended') {
      throw new Error('Routine session refused');
    }
    // Withhold identifiers if authority changed while the append reply was in flight.
    if (attemptedAppend) await saved.checkOwner();
    return { status: 'confirmed' as const, occurrenceId: saved.run.occurrenceId,
      conversationId: saved.run.conversationId, eventId: saved.command.id, position: result.sequence,
      startBy: saved.run.startBy, executionAvailable: false as const };
  } catch {
    throw new Error('Routine session refused');
  }
}

export async function loadRoutinePreparation(store: EventStore,
  keys: ReturnType<typeof conversationKeys>, worker: Worker, raw: unknown) {
  try {
    const input = inputSchema.parse(raw);
    const workerId = z.string().regex(/^[\w-]{1,200}$/u).parse(worker.workerId);
    const saved = await loadPreparation(store, worker, input);
    const run = saved.run;
    const ownerId = run.definition.ownerId;
    const options = { silo: worker.silo, binding: worker.binding, store };
    const now = worker.now ?? Date.now;
    let fresh: Awaited<ReturnType<typeof ownershipWriteAccess>> | undefined;
    async function checkCurrent() {
      if (!fresh) {
        throw new Error('Routine session refused');
      }
      // Read only new routine facts; growing histories never enter the access watch.
      for await (const row of store.readStream(`routine-${input.routineId}`,
        saved.position + 1, fresh.deadline)) {
        saved.state = foldRoutineHistory(saved.state, row.event, saved.completed);
        saved.position = row.sequence;
      }
      const current = requireRun(saved.state, input.occurrenceId);
      if (!isDeepStrictEqual(current, run) ||
          !(await worker.checkCurrent(fresh.deadline))) {
        throw new Error('Routine session refused');
      }
      await fresh();
      if (now() < Date.parse(run.firedAt) || now() >= Date.parse(run.startBy)) {
        throw new Error('Routine session refused');
      }
    }
    async function checkOwner() {
      if (!fresh || !(await saved.access.check('manage')).allowed) {
        throw new Error('Routine session refused');
      }
      await sharedAssistantAuthority(options, ownerId, run.definition.assistantId,
        run.definition.payingGroupId, fresh);
      await checkCurrent();
    }
    async function checkAccess() {
      // Finish history before starting the two-second write check.
      fresh = await ownershipWriteAccess(store, saved.positions);
      await checkOwner();
      return fresh.deadline;
    }
    async function checkModel(model: string, rows: StoredEvent[]) {
      if (!fresh) throw new Error('Routine session refused');
      await currentAuthority(store, worker.binding, ownerId, run.definition.assistantId,
        run.conversationId, 'model', model, fresh, rows);
    }
    function accessSubjects() {
      if (!fresh) {
        throw new Error('Routine session refused');
      }
      return fresh.subjects();
    }
    async function checkFresh(operation: 'retry' | 'append') {
      const deadline = await checkAccess();
      if (operation === 'append') {
        keys.provision(worker.silo, run.conversationId);
      }
      return deadline;
    }
    const context = { silo: worker.silo, memberId: ownerId };
    const command = { id: `routine-session-create-${run.occurrenceId}`,
      conversationId: run.conversationId, assistantId: run.definition.assistantId,
      mode: 'agent_session', payingGroupId: run.definition.payingGroupId };
    const { id: _id, ...creation } = command;
    const routinePreparation = { routineId: input.routineId, occurrenceId: run.occurrenceId,
      claimId: saved.claim.event.id, claimPosition: saved.claim.sequence, workerId };
    const expectedCreation = { ...creation, createdBy: ownerId, routinePreparation };
    async function* readStream(subject: string, from?: number, deadline?: number) {
      for await (const row of store.readStream(subject, from, deadline)) {
        if (row.event.type === 'conversation.created' &&
            (row.sequence <= saved.claim.sequence || row.event.commandId !== command.id ||
              row.event.id !== command.id || row.event.silo !== worker.silo ||
              row.event.subject !== `conversation-${run.conversationId}` ||
              row.event.source !== 'opencrane-server' || row.event.principal?.kind !== 'human' ||
              row.event.principal.id !== ownerId ||
              !isDeepStrictEqual(row.event.data, expectedCreation))) {
          throw new Error('Routine session refused');
        }
        yield row;
      }
    }
    return { run, readStream, context, command, expectedCreation, position: saved.position,
      checkAccess, checkFresh, checkOwner, checkCurrent, checkModel, accessSubjects };
  } catch {
    // Keep missing access and private history or custody failures indistinguishable.
    throw new Error('Routine session refused');
  }
}
