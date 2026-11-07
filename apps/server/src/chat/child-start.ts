import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { chatIdSchema, childRequestedEventSchema, computerTurnStartedDataSchema,
  conversationCreatedDataSchema } from '@opencrane/events';
import { readEventAt } from '@opencrane/event-store';
import { currentAuthority, providerTurnAdmission, reservationCents, requireRootStartCapacity,
  type BudgetActor } from '@opencrane/models';
import { checkedChildActivation } from './child-activation.ts';
import { childStartState } from './child-failure.ts';
import { ChildRequestChanged } from './child-requests.ts';
import { allocateChildRoot, loadRootPreparation, rootPreparationModel }
  from './child-root.ts';
import { turnCommand } from './turns.ts';
import { chatHistory } from './commands.ts';
import { creationEvent } from './private-session.ts';

type Options = Parameters<typeof allocateChildRoot>[0];
type Selection = Parameters<typeof allocateChildRoot>[5];
type Send = (binding: { rootId: string; turnId: string }) => Promise<void>;
const recordedStart = z.strictObject({
  conversationId: chatIdSchema, turnId: chatIdSchema, threadId: chatIdSchema,
  assistantId: chatIdSchema, computerId: chatIdSchema, generation: z.int().positive(),
});
const startReportData = z.object({ conversationId: chatIdSchema, turnId: chatIdSchema,
  threadId: chatIdSchema, assistantId: chatIdSchema,
  executionMode: z.literal('restricted'), sharingClass: z.literal('shared_only') });

function matchesRootStart(start: z.infer<typeof computerTurnStartedDataSchema>,
  root: Awaited<ReturnType<typeof allocateChildRoot>>) {
  return start.turnId === root.turnId && start.threadId === root.threadId &&
    start.rootId === root.rootId && start.computerId === root.computerId &&
    start.assistantId === root.assistantId &&
    start.conversationId === root.conversationId &&
    start.requesterId === root.requesterId &&
    start.payingGroupId === root.payingGroupId &&
    start.executionMode === 'restricted' && start.sharingClass === 'shared_only';
}

async function checkComputerChanges(options: Options,
  root: Awaited<ReturnType<typeof allocateChildRoot>>, position: number, deadline: number) {
  const subject = `computer-${root.assistantId}`;
  for await (const row of options.store.readStream(subject, position + 1, deadline)) {
    const start = row.event.type === 'computer.turn_started'
      ? computerTurnStartedDataSchema.safeParse(row.event.data) : undefined;
    if (!start?.success || !matchesRootStart(start.data, root) ||
        row.event.silo !== options.silo) {
      throw new ChildRequestChanged('Child computer changed');
    }
  }
}

// Admit only the original saved input. A saved computer start makes an uncertain send final.
export async function startActivatedChild(options: Options, actor: BudgetActor, memberId: string,
  value: unknown, attempt: number, selection: Selection, send: Send) {
  if (actor.store !== options.store || actor.silo !== options.silo) {
    throw new ChildRequestChanged('Child start unavailable');
  }
  const selected = { ...selection };
  const prepared = await loadRootPreparation(options, value, selected);
  const model = rootPreparationModel(prepared.admission);
  const firstCallBoundCents = reservationCents(model, 2000);
  const root = await allocateChildRoot(options, actor, memberId, value, attempt, selected);
  const binding = { rootId: root.rootId, turnId: root.turnId };

  async function childStart() {
    // Load growing histories before starting the final two-second access check.
    const checked = await checkedChildActivation(options, memberId, value, attempt);
    if (!checked.activated || checked.intent.data.firstInputId !== root.turnId ||
        checked.intent.data.childConversationId !== root.conversationId ||
        checked.intent.data.payingGroupId !== root.payingGroupId) {
      throw new ChildRequestChanged('Child start unavailable');
    }
    const fresh = checked.fresh;
    async function confirm() {
      await checked.confirmAccess();
      const current = await providerTurnAdmission(options.store, options.silo,
        root.assistantId, fresh.deadline);
      if (current.enabled !== prepared.admission.enabled ||
          current.draining !== prepared.admission.draining ||
          !isDeepStrictEqual(current.choice, prepared.admission.choice)) {
        throw new ChildRequestChanged('Child provider changed');
      }
      await checkComputerChanges(options, root, prepared.computer.sequence, fresh.deadline);
      await currentAuthority(options.store, options.binding, root.requesterId,
        root.assistantId, root.conversationId, 'model', model, fresh, checked.rows);
      await checked.confirmAccess();
      await actor.requireCurrent(fresh.deadline);
      requireRootStartCapacity(actor.state, root.rootId, firstCallBoundCents, actor.now());
    }
    await confirm();
    return { rootId: root.rootId, requesterId: root.requesterId,
      conversationId: root.conversationId, turnId: root.turnId, threadId: root.threadId,
      computerId: root.computerId, assistantId: root.assistantId,
      payingGroupId: root.payingGroupId,
      ...(prepared.admission.choice && prepared.admission.enabled
        ? { providerId: prepared.admission.choice.providerId,
          model,
          bindingSequence: prepared.admission.choice.bindingSequence } : {}),
      deadline: fresh.deadline, fresh: confirm };
  }
  async function onStartSaved(saved: unknown, status: string) {
    if (saved && status === 'started') await send(binding);
  }
  const context = { silo: options.silo, computerId: selected.computerId,
    assistantId: root.assistantId, binding: options.binding, childStart, onChildStartSaved: onStartSaved };
  const report = { conversationId: root.conversationId, turnId: root.turnId,
    threadId: selected.threadId, executionMode: 'restricted' as const, status: 'started' as const };
  const admitted = await turnCommand(options.store, context, report);
  if (!admitted || admitted.rootId !== root.rootId) {
    throw new ChildRequestChanged('Child start unavailable');
  }
  return admitted;
}

function participantId(join: { participantId: string }) {
  return join.participantId;
}

// Recover the request from event records; the computer cannot select a parent, payer or audience.
export async function startRecordedChild(options: Options, actor: BudgetActor, raw: unknown) {
  const report = recordedStart.parse(raw);
  const subject = `conversation-${report.conversationId}`;
  const creation = await creationEvent(options.store, options.silo, subject,
    'conversation.created');
  const created = conversationCreatedDataSchema.parse(creation.data);
  if (!('contextKind' in created) || created.assistantId !== report.assistantId) {
    throw new ChildRequestChanged('Child start unavailable');
  }
  const origin = created.origin;
  if (origin.firstInputId !== report.turnId) {
    throw new ChildRequestChanged('Child start unavailable');
  }
  const parentSubject = `conversation-${origin.parentConversationId}`;
  const intentRow = await readEventAt(options.store, parentSubject,
    origin.intentPosition, performance.now() + 10_000);
  const intent = childRequestedEventSchema.safeParse(intentRow?.event);
  if (!intent.success || intent.data.silo !== options.silo ||
      intent.data.id !== origin.intentEventId ||
      intent.data.data.childConversationId !== report.conversationId ||
      intent.data.data.firstInputId !== report.turnId) {
    throw new ChildRequestChanged('Child start unavailable');
  }
  const saved = intent.data.data;
  const child = await chatHistory(options.store, options.silo, report.conversationId);
  function matchesStart(row: typeof child[number]) {
    if (row.event.type !== 'agent.turn_started' ||
        row.event.source !== 'computer-bridge' ||
        row.event.report?.computerId !== report.computerId) return false;
    const data = startReportData.safeParse(row.event.data);
    return data.success && data.data.conversationId === report.conversationId &&
      data.data.turnId === report.turnId && data.data.threadId === report.threadId &&
      data.data.assistantId === report.assistantId;
  }
  if (!child.some(matchesStart)) throw new ChildRequestChanged('Child start unavailable');
  const parent = await chatHistory(options.store, options.silo, origin.parentConversationId);
  const current = childStartState(parent, intent.data.id);
  if (current.failure) throw new ChildRequestChanged('Child start unavailable');
  const input = { conversationId: saved.conversationId, sourceMessageId: saved.sourceMessageId,
    requestId: saved.requestId, assistantId: saved.assistantId,
    payingGroupId: saved.payingGroupId, allowanceBoundCents: saved.allowanceBoundCents,
    participantIds: saved.initialJoins.map(participantId) };
  const selection = { threadId: report.threadId, computerId: report.computerId,
    generation: report.generation };
  function acknowledgeSavedStart() { return Promise.resolve(); }
  return startActivatedChild(options, actor, saved.createdBy, input, current.attempt,
    selection, acknowledgeSavedStart);
}
