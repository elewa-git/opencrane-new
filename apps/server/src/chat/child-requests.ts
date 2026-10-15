import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { authorityFence, groupMembership } from '@opencrane/models';
import { readEventAt, type StoredEvent } from '@opencrane/event-store';
import { chatIdSchema, childRequestedDataSchema, childRequestedEventSchema,
  conversationCreatedDataSchema, messagePostedDataSchema, type ChildRequest }
  from '@opencrane/events';
import { chatHistory, ChatConflict } from './commands.ts';
import { chatAccess, type ChatOptions } from './access.ts';
import { creationEvent, sharedAssistantAuthority, sharedAssistantRead } from './private-session.ts';
import { participationClosed } from './participation.ts';

type Options = Pick<ChatOptions, 'store' | 'silo' | 'binding' | 'db'>;
const inputSchema = z.strictObject({
  conversationId: chatIdSchema, sourceMessageId: chatIdSchema, requestId: chatIdSchema,
  assistantId: chatIdSchema, payingGroupId: chatIdSchema,
  participantIds: z.array(chatIdSchema).min(1).max(97),
  allowanceBoundCents: childRequestedDataSchema.shape.allowanceBoundCents.default(1000),
});
type Input = z.infer<typeof inputSchema>;
const assistantSchema = z.object({ kind: z.literal('team'), payingGroupId: z.string() });
function stageId(options: Options, input: Input, stage: string) {
  const identity = JSON.stringify([options.silo, input.conversationId, input.sourceMessageId]);
  const hash = createHash('sha256');
  hash.update(identity);
  return `${stage}-${hash.digest('hex')}`;
}
function refused(): never {
  throw new ChatConflict('Child request unavailable');
}
async function load(options: Options, memberId: string, value: unknown) {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) refused();
  const input = parsed.data;
  const rows = await chatHistory(options.store, options.silo, input.conversationId);
  const intentId = stageId(options, input, 'child-intent');
  let source: StoredEvent | undefined;
  let intent: StoredEvent | undefined;
  let sequence = 0;
  for (const row of rows) {
    if (row.event.type === 'conversation.closed') refused();
    if (row.event.subject === `conversation-${input.conversationId}`) sequence = row.sequence;
    if (row.event.id === input.sourceMessageId) source = row;
    if (row.event.id === intentId) intent = row;
  }
  requireOwnSource(source, input, memberId);
  return { input, source, intent, sequence };
}
function requireOwnSource(source: StoredEvent | undefined, input: Input, memberId: string)
  : asserts source is StoredEvent {
  if (!source || source.event.type !== 'message.posted' ||
      source.event.subject !== `conversation-${input.conversationId}` ||
      source.event.principal?.kind !== 'human' || source.event.principal.id !== memberId) refused();
  const posted = messagePostedDataSchema.safeParse(source.event.data);
  if (!posted.success || posted.data.authorKind !== 'human' ||
      posted.data.authorId !== memberId || posted.data.conversationId !== input.conversationId) {
    refused();
  }
}
type Loaded = Awaited<ReturnType<typeof load>>;
async function check(options: Options, memberId: string, loaded: Loaded,
  audience: string[], writing = true) {
  const { input, source } = loaded;
  const subjects = [`member-${memberId}`, `participation-${input.conversationId}`];
  for (const participantId of audience) subjects.push(`member-${participantId}`);
  let fresh: Awaited<ReturnType<typeof authorityFence>> | undefined;
  if (writing) fresh = await authorityFence(options.store, performance.now(), subjects);
  const deadline = fresh?.deadline ?? performance.now() + 2000;
  const assistantEvent = await creationEvent(options.store, options.silo,
    `assistant-${input.assistantId}`, 'assistant.created', deadline);
  const assistant = assistantSchema.safeParse(assistantEvent.data);
  if (!assistant.success || assistant.data.payingGroupId !== input.payingGroupId) refused();
  if (fresh) {
    await sharedAssistantAuthority(options, memberId, input.assistantId, input.payingGroupId, fresh);
  } else {
    await sharedAssistantRead(options, memberId, input.assistantId, assistantEvent);
    await groupMembership(options.store, options.silo, memberId,
      input.payingGroupId, options.binding, deadline);
  }
  const initialJoins: ChildRequest['initialJoins'] = [];
  for (const participantId of audience) {
    const request = { memberId: participantId, conversationId: input.conversationId,
      relation: 'post' as const, deadline };
    const access = await chatAccess(options, request);
    if (access.mode !== 'group' || !access.joinEventId ||
        access.joinPosition >= source.sequence) refused();
    initialJoins.push({ participantId, parentJoinEventId: access.joinEventId,
      parentJoinPosition: access.joinPosition });
  }
  if (await participationClosed(options.store, options.silo, input.conversationId,
    deadline)) refused();
  await fresh?.();
  return { initialJoins, fresh };
}
async function review(options: Options, memberId: string, loaded: Loaded, writing = true) {
  const { input, source } = loaded;
  const audience = [...input.participantIds].sort();
  if (!audience.includes(memberId) || new Set(audience).size !== audience.length) refused();
  const checked = await check(options, memberId, loaded, audience, writing);
  const candidate = { conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId, sourcePosition: source.sequence,
    requestId: input.requestId, childConversationId: stageId(options, input, 'child'),
    firstInputId: stageId(options, input, 'child-input'), createdBy: memberId,
    assistantId: input.assistantId, payingGroupId: input.payingGroupId,
    allowanceBoundCents: input.allowanceBoundCents, initialJoins: checked.initialJoins };
  const data = childRequestedDataSchema.parse(candidate);
  return { data, fresh: checked.fresh };
}
export async function reviewChildRequest(options: Options, memberId: string, value: unknown) {
  const loaded = await load(options, memberId, value);
  const reviewed = await review(options, memberId, loaded, false);
  return reviewed.data;
}
function savedIntent(options: Options, memberId: string, loaded: Loaded) {
  if (!loaded.intent) refused();
  const parsed = childRequestedEventSchema.safeParse(loaded.intent.event);
  if (!parsed.success) refused();
  const data = parsed.data.data;
  const { input, source } = loaded;
  function participantId(join: ChildRequest['initialJoins'][number]) {
    return join.participantId;
  }
  const people = data.initialJoins.map(participantId);
  const audience = [...input.participantIds].sort();
  if (parsed.data.silo !== options.silo || data.createdBy !== memberId ||
      data.sourceMessageId !== input.sourceMessageId || data.sourcePosition !== source.sequence ||
      data.assistantId !== input.assistantId || data.payingGroupId !== input.payingGroupId ||
      data.allowanceBoundCents !== input.allowanceBoundCents ||
      data.childConversationId !== stageId(options, input, 'child') ||
      data.firstInputId !== stageId(options, input, 'child-input') ||
      !isDeepStrictEqual(people, audience)) throw new ChatConflict('Child request changed');
  return { row: loaded.intent, data };
}
async function save(options: Options, memberId: string, id: string, subject: string,
  type: string, data: unknown, sequence: number,
  fresh: Awaited<ReturnType<typeof authorityFence>> | undefined) {
  if (!fresh) throw new Error('Child write check unavailable');
  const event = { id, commandId: id, subject, type, data, silo: options.silo,
    source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human' as const, id: memberId }, correlation: {} };
  await fresh();
  const command = { event, expectedSequence: sequence, historyChecked: true as const,
    deadline: fresh.deadline };
  const result = await options.store.append(command);
  if (result.status !== 'appended') throw new ChatConflict('Child request changed');
  const row = await readEventAt(options.store, subject, result.sequence, performance.now() + 10_000);
  if (!row) throw new Error('Child request outcome unavailable');
  verifySaved(row, event);
  return row;
}
function verifySaved(row: StoredEvent, expected: StoredEvent['event']) {
  const saved = row.event;
  if (saved.id !== expected.id || saved.commandId !== expected.commandId ||
      saved.silo !== expected.silo || saved.subject !== expected.subject ||
      saved.type !== expected.type || saved.source !== expected.source || saved.report ||
      !isDeepStrictEqual(saved.principal, expected.principal) ||
      !isDeepStrictEqual(saved.data, expected.data)) throw new ChatConflict('Child request changed');
}
export async function requestChild(options: Options, memberId: string, value: unknown) {
  const loaded = await load(options, memberId, value);
  if (loaded.intent) {
    const saved = savedIntent(options, memberId, loaded);
    await check(options, memberId, loaded, [memberId]);
    return saved.row;
  }
  const reviewed = await review(options, memberId, loaded);
  return save(options, memberId, stageId(options, loaded.input, 'child-intent'),
    `conversation-${loaded.input.conversationId}`, 'conversation.child_requested',
    reviewed.data, loaded.sequence, reviewed.fresh);
}
export async function createRequestedChild(options: Options, memberId: string, value: unknown) {
  const loaded = await load(options, memberId, value);
  const intent = savedIntent(options, memberId, loaded);
  const data = intent.data;
  const childRows = await chatHistory(options.store, options.silo, data.childConversationId);
  const candidate = { conversationId: data.childConversationId,
    mode: 'agent_session', contextKind: 'shared_child', createdBy: data.createdBy,
    assistantId: data.assistantId, payingGroupId: data.payingGroupId, initialJoins: data.initialJoins,
    origin: { parentConversationId: data.conversationId, sourceMessageId: data.sourceMessageId,
      sourcePosition: data.sourcePosition, intentEventId: intent.row.event.id,
      intentPosition: intent.row.sequence, requestId: data.requestId, firstInputId: data.firstInputId } };
  const created = conversationCreatedDataSchema.parse(candidate);
  const id = stageId(options, loaded.input, 'child-created');
  const subject = `conversation-${data.childConversationId}`;
  const checked = await check(options, memberId, loaded, [memberId]);
  const previous = childRows[0];
  if (previous) {
    const expected = { ...previous.event, id, commandId: id, subject, silo: options.silo,
      type: 'conversation.created', source: 'opencrane-server', data: created,
      principal: { kind: 'human' as const, id: memberId } };
    verifySaved(previous, expected);
    return previous;
  }
  return save(options, memberId, id, subject, 'conversation.created', created, 0, checked.fresh);
}
