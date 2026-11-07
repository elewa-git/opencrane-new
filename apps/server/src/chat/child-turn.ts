import { ReportRejected } from './reports.ts';

export type ChildStartAdmission = {
  rootId: string; requesterId: string; conversationId: string; turnId: string;
  threadId: string; computerId: string; assistantId: string; payingGroupId: string;
  model?: string | undefined; providerId?: string | undefined;
  bindingSequence?: number | undefined;
  deadline: number; fresh: () => Promise<void>;
};
type Context = { computerId: string; assistantId: string;
  childStart: () => Promise<ChildStartAdmission> };
type Data = { requesterId: string; conversationId: string; turnId: string;
  threadId?: string | undefined; rootId?: string | undefined;
  payingGroupId?: string | undefined; model?: string | undefined;
  providerId?: string | undefined; bindingSequence?: number | undefined;
  sharingClass?: 'shared_only' | undefined };
type Input = { messageId?: string | undefined; rootId?: string | undefined;
  senderAttemptId?: string | undefined };

export async function admitChildTurn(context: Context, data: Data,
  mode: 'restricted' | 'memory_free', requested: unknown, input: Input) {
  if (input.messageId !== undefined || input.rootId !== undefined ||
      input.senderAttemptId !== undefined || mode !== 'restricted' ||
      requested !== undefined) {
    throw new ReportRejected('Child start binding changed');
  }
  const child = await context.childStart();
  if (child.requesterId !== data.requesterId ||
      child.conversationId !== data.conversationId || child.turnId !== data.turnId ||
      child.threadId !== data.threadId || child.computerId !== context.computerId ||
      child.assistantId !== context.assistantId) {
    throw new ReportRejected('Child start binding changed');
  }
  data.rootId = child.rootId;
  data.payingGroupId = child.payingGroupId;
  data.model = child.model;
  data.providerId = child.providerId;
  data.bindingSequence = child.bindingSequence;
  data.sharingClass = 'shared_only';
  return { payer: child.payingGroupId, fresh: child.fresh,
    confirmBudget: child.fresh, deadline: child.deadline };
}
