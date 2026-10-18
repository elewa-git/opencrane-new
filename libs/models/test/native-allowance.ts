import type { fixture } from './fixture.ts';

type Context = Awaited<ReturnType<typeof fixture>>;
type Root = { requesterId: string; conversationId: string; turnId: string; threadId: string;
  assistantId: string; computerId: string; payingGroupId: string };

export async function saveNativeAllowance(context: Context, root: Root) {
  // Seed the allowance for saved-record tests, which never ask the actor to write holds.
  const data = { rootId: 'root', requesterId: root.requesterId,
    conversationId: root.conversationId, turnId: root.turnId, threadId: root.threadId,
    assistantId: root.assistantId, computerId: root.computerId, generation: 1,
    payingGroupId: root.payingGroupId, allowanceCents: 1000 };
  await context.append('budget-test', 'budget.root_allowance_set', data);
}
