import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isComputerLifecycle } from '@opencrane/auth';
import { computerTurnStartedDataSchema, computerTurnClosedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { priceTableId, providerTurnAdmission, reservationCents,
  RootBudgetRefused, type BudgetActor } from '@opencrane/models';
import { loadRootPreparation, requireRootComputer, rootPreparationModel }
  from './chat/child-root.ts';
import { loadRoutineInput } from './routine-input.ts';

type Arguments = Parameters<typeof loadRoutineInput>;
type Selection = Parameters<typeof requireRootComputer>[2];
const inputChangeTypes = ['conversation.created', 'conversation.closed', 'message.posted'];

function changesComputerPreparation(event: EventEnvelope, selected: Selection) {
  const type = event.type;
  if (isComputerLifecycle(type) || type.startsWith('takeover.')) {
    return true;
  }
  if (type !== 'computer.turn_started' && type !== 'computer.turn_closed') {
    return false;
  }
  const schema = type === 'computer.turn_started'
    ? computerTurnStartedDataSchema : computerTurnClosedDataSchema;
  const turn = schema.parse(event.data);
  return turn.threadId === selected.threadId;
}

async function checkComputerChanges(store: Arguments[0], assistantId: string,
  position: number, selected: Selection, deadline: number) {
  for await (const row of store.readStream(`computer-${assistantId}`, position + 1, deadline)) {
    if (changesComputerPreparation(row.event, selected)) {
      throw new Error('Routine root refused');
    }
    position = row.sequence;
  }
  return position;
}

// Accept computer and thread choices only from trusted preparation, never a public request.
export async function allocateRoutineRoot(store: Arguments[0], keys: Arguments[1],
  worker: Arguments[2], raw: unknown, actor: BudgetActor, selection: Selection) {
  try {
    return await allocate(store, keys, worker, raw, actor, selection);
  } catch {
    throw new Error('Routine root refused');
  }
}

async function allocate(store: Arguments[0], keys: Arguments[1], worker: Arguments[2],
  raw: unknown, actor: BudgetActor, selection: Selection) {
  if (actor.store !== store || actor.silo !== worker.silo) {
    throw new Error('Routine root refused');
  }
  const checked = await loadRoutineRootPreparation(store, keys, worker, raw, selection);
  const { binding, firstCallBoundCents, deadline, run } = checked;
  async function confirmAllocation() {
    await checked.confirmPreparation();
    // Recover the immutable amount from the actor's serial queue.
    for (const root of actor.state.roots) {
      if (root.conversationId === run.conversationId && root.turnId === run.turnId) {
        binding.allowanceCents = root.allowanceCents;
      }
    }
  }
  let root;
  try {
    root = await actor.setRootAllowance(binding, firstCallBoundCents, confirmAllocation, deadline);
  } catch (error) {
    if (!(error instanceof RootBudgetRefused) || error.reason !== 'allowance_unavailable' ||
        error.availableCents < firstCallBoundCents || error.availableCents >= binding.allowanceCents) {
      throw error;
    }
    // Use the actor's checked remaining capacity; the retry still checks every ceiling and right.
    binding.allowanceCents = error.availableCents;
    root = await actor.setRootAllowance(binding, firstCallBoundCents, confirmAllocation, deadline);
  }
  await checked.confirmReceipt();
  return { status: 'confirmed' as const, occurrenceId: run.occurrenceId,
    conversationId: run.conversationId, rootId: root.rootId, allowanceCents: root.allowanceCents,
    startBy: run.startBy, executionAvailable: false as const };
}

export async function loadRoutineRootPreparation(store: Arguments[0], keys: Arguments[1],
  worker: Arguments[2], raw: unknown, selection: Selection, allowActivation = false) {
  const selected = { threadId: selection.threadId, computerId: selection.computerId,
    generation: selection.generation };
  const input = await loadRoutineInput(store, keys, worker, raw, allowActivation);
  const { preparation, previous, rows } = input;
  if (!previous) {
    throw new Error('Routine root refused');
  }
  const run = preparation.run;
  const assistantId = run.definition.assistantId;
  const options = { store, silo: worker.silo };
  const assistant = { assistantId };
  const prepared = await loadRootPreparation(options, assistant, selected);
  const computerBinding = { assistantId, createdBy: run.definition.ownerId,
    childConversationId: run.conversationId, firstInputId: run.turnId };
  requireRootComputer(prepared, computerBinding, selected);
  const admission = prepared.admission;
  const model = rootPreparationModel(admission);
  const firstCallBoundCents = reservationCents(model, 2000);
  const hash = createHash('sha256');
  const fingerprintFields = [run, rows[0], previous, admission.enabled, admission.choice,
    model, priceTableId, firstCallBoundCents];
  const fingerprint = JSON.stringify(fingerprintFields);
  hash.update(fingerprint);
  const preparationDigest = hash.digest('hex');
  const binding = { requesterId: run.definition.ownerId, conversationId: run.conversationId,
    turnId: run.turnId, assistantId, payingGroupId: run.definition.payingGroupId,
    ...selected, allowanceCents: 1000, preparationDigest };
  // Complete all growing histories before starting the original two-second access check.
  const deadline = await preparation.checkAccess();
  await preparation.checkModel(model, rows);
  let position = rows.at(-1)!.sequence;
  let computerPosition = prepared.computer.sequence;
  async function confirmPreparation() {
    await preparation.checkOwner();
    const current = await providerTurnAdmission(store, worker.silo, assistantId, deadline);
    if (current.enabled !== admission.enabled || current.draining !== admission.draining ||
        !isDeepStrictEqual(current.choice, admission.choice)) {
      throw new Error('Routine root refused');
    }
    computerPosition = await checkComputerChanges(store, assistantId,
      computerPosition, selected, deadline);
    // Reject later input or closure while allowing unrelated chat activity.
    for await (const row of store.readStream(`conversation-${run.conversationId}`,
      position + 1, deadline)) {
      if (inputChangeTypes.includes(row.event.type)) {
        throw new Error('Routine root refused');
      }
      position = row.sequence;
    }
    await preparation.checkCurrent();
    input.verify(previous!);
  }
  const receiptSubjects = preparation.accessSubjects();
  const preparationPositions = new Map<string, number>([
    [`routine-${run.routineId}`, preparation.position],
    [`conversation-${run.conversationId}`, position],
    [`computer-${assistantId}`, computerPosition],
  ]);
  let preparationChangePosition = 0;
  function changesPreparation(subject: string, event: EventEnvelope) {
    if (subject === `computer-${assistantId}`) {
      return changesComputerPreparation(event, selected);
    }
    if (subject === `conversation-${run.conversationId}`) {
      return inputChangeTypes.includes(event.type);
    }
    return true;
  }
  async function readReceiptSubject(subject: string) {
    return store.head(subject, deadline);
  }
  async function receiptState() {
    // Read only new preparation events. Keep growing histories out of the access watch.
    for (const [subject, position] of preparationPositions) {
      for await (const row of store.readStream(subject, position + 1, deadline)) {
        preparationPositions.set(subject, row.sequence);
        if (changesPreparation(subject, row.event)) {
          preparationChangePosition = Math.max(preparationChangePosition, row.sequence);
        }
      }
    }
    const reads = receiptSubjects.map(readReceiptSubject);
    const positions = await Promise.all(reads);
    const current = await providerTurnAdmission(store, worker.silo, assistantId, deadline);
    // Compare this assistant's choice and mode, not other calls' spending or provider choices.
    return { positions, preparationChangePosition,
      enabled: current.enabled, draining: current.draining, choice: current.choice };
  }
  async function confirmReceipt() {
    // Repeat only for changes to this allocation's access, preparation or provider settings.
    // Keep every pass within the original access deadline.
    let before: Awaited<ReturnType<typeof receiptState>>;
    let after: Awaited<ReturnType<typeof receiptState>>;
    do {
      before = await receiptState();
      await confirmPreparation();
      after = await receiptState();
    } while (!isDeepStrictEqual(before, after));
  }
  return { preparation, binding, run, firstCallBoundCents, deadline,
    confirmPreparation, confirmReceipt, receiptState };
}
