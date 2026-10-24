import { currentAuthority, reservationCents, type BudgetActor } from '@opencrane/models';
import { checkedChildActivation } from './child-activation.ts';
import { ChildRequestChanged } from './child-requests.ts';

type Options = Parameters<typeof checkedChildActivation>[0];
type Selection = { threadId: string; computerId: string; generation: number; model: string };

// Accept execution choices only from the server preparing the first turn.
export async function allocateChildRoot(options: Options, actor: BudgetActor, memberId: string,
  value: unknown, attempt: number, selected: Selection) {
  if (actor.silo !== options.silo || actor.store !== options.store) {
    throw new ChildRequestChanged('Child allocation unavailable');
  }
  const checked = await checkedChildActivation(options, memberId, value, attempt);
  if (!checked.activated) throw new ChildRequestChanged('Child activation unavailable');
  const { intent, fresh, rows, confirmAccess } = checked;
  const saved = intent.data;
  await currentAuthority(options.store, options.binding, saved.createdBy, saved.assistantId,
    saved.childConversationId, 'model', selected.model, fresh, rows);
  // Bound an unmeasured first request by the full context and the server's 2,000-token output cap.
  const firstCallBoundCents = reservationCents(selected.model, 2000);
  const binding = { requesterId: saved.createdBy, conversationId: saved.childConversationId,
    turnId: saved.firstInputId, assistantId: saved.assistantId, payingGroupId: saved.payingGroupId,
    allowanceCents: saved.allowanceBoundCents, threadId: selected.threadId,
    computerId: selected.computerId, generation: selected.generation };
  return actor.setRootAllowance(binding, firstCallBoundCents, confirmAccess, fresh.deadline);
}
