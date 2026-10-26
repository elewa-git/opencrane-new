import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { readStreamSummary } from '@opencrane/event-store';
import { chatIdSchema, type ChildRequest } from '@opencrane/events';
import { currentAuthority, modelForTask, providerTurnAdmission, reservationCents,
  type BudgetActor } from '@opencrane/models';
import { checkedChildActivation } from './child-activation.ts';
import { ChildRequestChanged } from './child-requests.ts';

type Options = Parameters<typeof checkedChildActivation>[0];
type Selection = { threadId: string; computerId: string; generation: number };
type Admission = Awaited<ReturnType<typeof providerTurnAdmission>>;
const assistantInput = z.object({ assistantId: chatIdSchema });
const readyComputer = z.object({
  assistantId: chatIdSchema, computerId: z.string().min(1), generation: z.int().positive(),
});

export async function loadRootPreparation(options: Pick<Options, 'store' | 'silo'>,
  value: unknown, selected: Selection) {
  const parsed = assistantInput.safeParse(value);
  if (!parsed.success) {
    throw new ChildRequestChanged('Child request unavailable');
  }
  const assistantId = parsed.data.assistantId;
  const deadline = performance.now() + 10_000;
  const admission = await providerTurnAdmission(options.store, options.silo, assistantId, deadline);
  function takeComputer(summary: ComputerSummary, sequence: number) {
    const thread = summary.threads.get(selected.threadId);
    return { lifecycle: summary.lifecycle, control: summary.control,
      thread: structuredClone(thread), sequence };
  }
  const computer = await readStreamSummary(options.store, options.silo,
    `computer-${assistantId}`, computerSummary, deadline, takeComputer);
  return { assistantId, admission, computer };
}

export function rootPreparationModel(admission: Admission) {
  if (admission.draining) {
    throw new ChildRequestChanged('Child provider unavailable');
  }
  // Keep the ordinary task choice only while managed provider calls are disabled.
  if (!admission.enabled) {
    return modelForTask('chat_turn');
  }
  if (!admission.choice || admission.choice.state === 'paused') {
    throw new ChildRequestChanged('Child provider unavailable');
  }
  return admission.choice.model;
}

export function requireRootComputer(prepared: Awaited<ReturnType<typeof loadRootPreparation>>,
  saved: Pick<ChildRequest, 'assistantId' | 'createdBy' | 'childConversationId' | 'firstInputId'>,
  selected: Selection) {
  const { computer, assistantId } = prepared;
  const ready = readyComputer.safeParse(computer.lifecycle?.event.data);
  if (assistantId !== saved.assistantId || computer.control ||
      computer.lifecycle?.event.type !== 'computer.ready' || !ready.success ||
      ready.data.assistantId !== assistantId || ready.data.computerId !== selected.computerId ||
      ready.data.generation !== selected.generation) {
    throw new ChildRequestChanged('Child computer changed');
  }
  if (!computer.thread) {
    return;
  }
  const owner = JSON.stringify([saved.createdBy, saved.childConversationId]);
  for (const recordedOwner of computer.thread.owners) {
    if (recordedOwner !== owner) {
      throw new ChildRequestChanged('Child thread unavailable');
    }
  }
  for (const turnId of computer.thread.startedTurnIds) {
    if (turnId !== saved.firstInputId) {
      throw new ChildRequestChanged('Child thread unavailable');
    }
  }
}

// Accept the restricted thread only from trusted server preparation, never an HTTP input.
export async function allocateChildRoot(options: Options, actor: BudgetActor, memberId: string,
  value: unknown, attempt: number, selection: Selection) {
  if (actor.silo !== options.silo || actor.store !== options.store) {
    throw new ChildRequestChanged('Child allocation unavailable');
  }
  const selected = { ...selection };
  let prepared: Awaited<ReturnType<typeof loadRootPreparation>> | undefined;
  let preparationError: unknown;
  try {
    prepared = await loadRootPreparation(options, value, selected);
  } catch (error) {
    preparationError = error;
  }
  // Check current access before reporting failed preparation as well as after successful reads.
  const checked = await checkedChildActivation(options, memberId, value, attempt);
  if (!checked.activated) {
    throw new ChildRequestChanged('Child activation unavailable');
  }
  if (!prepared) {
    throw new ChildRequestChanged('Child preparation unavailable', { cause: preparationError });
  }
  const { intent, fresh, rows, confirmAccess } = checked;
  const saved = intent.data;
  requireRootComputer(prepared, saved, selected);
  const admission = prepared.admission;
  const computerSequence = prepared.computer.sequence;
  const model = rootPreparationModel(admission);
  await currentAuthority(options.store, options.binding, saved.createdBy, saved.assistantId,
    saved.childConversationId, 'model', model, fresh, rows);
  async function confirmPreparation() {
    await fresh();
    const current = await providerTurnAdmission(options.store, options.silo,
      saved.assistantId, fresh.deadline);
    if (current.enabled !== admission.enabled || current.draining !== admission.draining ||
        !isDeepStrictEqual(current.choice, admission.choice)) {
      throw new ChildRequestChanged('Child provider changed');
    }
    const sequence = await options.store.head(`computer-${saved.assistantId}`, fresh.deadline);
    if (sequence !== computerSequence) {
      throw new ChildRequestChanged('Child computer changed');
    }
    await confirmAccess();
  }
  // Bound an unmeasured first request by the full context and the server's 2,000-token output cap.
  const firstCallBoundCents = reservationCents(model, 2000);
  const binding = { requesterId: saved.createdBy, conversationId: saved.childConversationId,
    turnId: saved.firstInputId, assistantId: saved.assistantId, payingGroupId: saved.payingGroupId,
    allowanceCents: saved.allowanceBoundCents, threadId: selected.threadId,
    computerId: selected.computerId, generation: selected.generation };
  return actor.setRootAllowance(binding, firstCallBoundCents, confirmPreparation, fresh.deadline);
}
