import { childStartFailure, childStartState } from './child-failure.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { childRetryInputSchema } from '@opencrane/protocol';
import { authorityFence, groupMembership } from '@opencrane/models';
import { readEventAt, type StoredEvent } from '@opencrane/event-store';
import { chatIdSchema, childRequestedDataSchema, childRequestedEventSchema,
  childRetryRequestedEventSchema, childRetryRequestedDataSchema,
  conversationCreatedDataSchema, messagePostedDataSchema, type ChildRequest }
  from '@opencrane/events';
import { chatHistory, ChatConflict } from './commands.ts';
import { chatAccess, conversationParticipation, type ChatOptions } from './access.ts';
import { creationEvent, sharedAssistantAuthority, sharedAssistantRead } from './private-session.ts';
import { participationClosed } from './participation.ts';

export class ChildRequestRefused extends ChatConflict {}
export class ChildRequestClosed extends ChatConflict {}
export class ChildRequestChanged extends ChatConflict {}
export class ChildRequestRace extends ChildRequestChanged {}
export class ChildRequestFailed extends ChatConflict {}

type Options = Pick<ChatOptions, 'store' | 'silo' | 'binding' | 'db' | 'keys'>;
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
  throw new ChildRequestRefused('Child request unavailable');
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
  let closed = false;
  for (const row of rows) {
    if (row.event.type === 'conversation.closed') closed = true;
    if (row.event.subject === `conversation-${input.conversationId}`) sequence = row.sequence;
    if (row.event.id === input.sourceMessageId) source = row;
    if (row.event.id === intentId) intent = row;
    if (row.event.type === 'conversation.child_requested') {
      const previous = childRequestedDataSchema.parse(row.event.data);
      if (previous.requestId === input.requestId && previous.sourceMessageId !== input.sourceMessageId) {
        throw new ChildRequestChanged('Child request changed');
      }
    }
  }
  requireOwnSource(source, input, memberId);
  const failed = childStartFailure(rows, intentId) !== undefined;
  return { input, source, intent, sequence, failed, closed, rows };
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
function requireUnfailed(loaded: Loaded) {
  if (loaded.failed) throw new ChildRequestFailed('Child request failed');
}
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
  // Reveal closure only after checking current access and source visibility.
  await requireOpenParent(options, loaded, deadline);
  await fresh?.();
  requireUnfailed(loaded);
  return { initialJoins, fresh };
}
async function requireOpenParent(options: Options, loaded: Loaded, deadline: number) {
  if (loaded.closed || await participationClosed(options.store, options.silo,
    loaded.input.conversationId, deadline)) {
    throw new ChildRequestClosed('Conversation closed');
  }
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
      !isDeepStrictEqual(people, audience)) throw new ChildRequestChanged('Child request changed');
  return { row: loaded.intent, data };
}
async function save(options: Options, memberId: string, id: string, subject: string,
  type: string, data: unknown, sequence: number,
  fresh: Awaited<ReturnType<typeof authorityFence>> | undefined,
  verify: typeof verifySaved = verifySaved) {
  if (!fresh) throw new Error('Child write check unavailable');
  const event = { id, commandId: id, subject, type, data, silo: options.silo,
    source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human' as const, id: memberId }, correlation: {} };
  await fresh();
  const command = { event, expectedSequence: sequence, historyChecked: true as const,
    deadline: fresh.deadline };
  const result = await options.store.append(command);
  if (result.status === 'conflict') throw new ChildRequestRace('Child request changed');
  if (result.status !== 'appended') throw new Error('Child request outcome unavailable');
  const row = await readEventAt(options.store, subject, result.sequence, performance.now() + 10_000);
  if (!row) throw new Error('Child request outcome unavailable');
  verify(row, event);
  return row;
}
function verifySaved(row: StoredEvent, expected: StoredEvent['event']) {
  const saved = row.event;
  if (saved.id !== expected.id || saved.commandId !== expected.commandId ||
      saved.silo !== expected.silo || saved.subject !== expected.subject ||
      saved.type !== expected.type || saved.source !== expected.source || saved.report ||
      !isDeepStrictEqual(saved.principal, expected.principal) ||
      !isDeepStrictEqual(saved.data, expected.data)) throw new ChildRequestChanged('Child request changed');
}
export async function requestChild(options: Options, memberId: string, value: unknown,
  expected?: ChildRequest) {
  const loaded = await load(options, memberId, value);
  if (loaded.intent) {
    const saved = savedIntent(options, memberId, loaded);
    await check(options, memberId, loaded, [memberId]);
    return saved.row;
  }
  const reviewed = await review(options, memberId, loaded);
  if (expected && !isDeepStrictEqual(reviewed.data, expected)) {
    throw new ChildRequestChanged('Child review changed');
  }
  return save(options, memberId, stageId(options, loaded.input, 'child-intent'),
    `conversation-${loaded.input.conversationId}`, 'conversation.child_requested',
    reviewed.data, loaded.sequence, reviewed.fresh);
}
export async function createRequestedChild(options: Options, memberId: string, value: unknown) {
  const loaded = await load(options, memberId, value);
  const intent = savedIntent(options, memberId, loaded);
  const data = intent.data;
  const childRows = await chatHistory(options.store, options.silo, data.childConversationId);
  const created = childCreation(intent);
  const id = stageId(options, loaded.input, 'child-created');
  const subject = `conversation-${data.childConversationId}`;
  const checked = await check(options, memberId, loaded, [memberId]);
  const previous = childRows[0];
  if (previous) {
    verifyCreation(options, memberId, loaded, intent, previous);
    return previous;
  }
  return save(options, memberId, id, subject, 'conversation.created', created, 0, checked.fresh);
}

function childCreation(intent: ReturnType<typeof savedIntent>) {
  const data = intent.data;
  const candidate = { conversationId: data.childConversationId,
    mode: 'agent_session', contextKind: 'shared_child', createdBy: data.createdBy,
    assistantId: data.assistantId, payingGroupId: data.payingGroupId, initialJoins: data.initialJoins,
    origin: { parentConversationId: data.conversationId, sourceMessageId: data.sourceMessageId,
      sourcePosition: data.sourcePosition, intentEventId: intent.row.event.id,
      intentPosition: intent.row.sequence, requestId: data.requestId, firstInputId: data.firstInputId } };
  return conversationCreatedDataSchema.parse(candidate);
}
function verifyCreation(options: Options, memberId: string, loaded: Loaded,
  intent: ReturnType<typeof savedIntent>, previous: StoredEvent) {
  const id = stageId(options, loaded.input, 'child-created');
  const expected = { ...previous.event, id, commandId: id, silo: options.silo,
    subject: `conversation-${intent.data.childConversationId}`, type: 'conversation.created',
    source: 'opencrane-server', data: childCreation(intent),
    principal: { kind: 'human' as const, id: memberId } };
  verifySaved(previous, expected);
}
function inputText(options: Options, conversationId: string, data: unknown) {
  try {
    return options.keys.decrypt(options.silo, conversationId, data);
  } catch {
    // Keep key read failures retryable; unreadable input is not a proven refusal.
    throw new ChatConflict('Child input unavailable');
  }
}
export async function addChildFirstInput(options: Options, memberId: string, value: unknown) {
  const loaded = await load(options, memberId, value);
  const intent = savedIntent(options, memberId, loaded);
  const { childConversationId, firstInputId } = intent.data;
  const rows = await chatHistory(options.store, options.silo, childConversationId);
  const creation = rows[0];
  if (!creation) refused();
  verifyCreation(options, memberId, loaded, intent, creation);
  for (const row of rows) {
    if (row.event.type === 'conversation.closed') throw new ChildRequestClosed('Conversation closed');
  }
  const checked = await check(options, memberId, loaded, [memberId]);
  const fresh = checked.fresh;
  if (!fresh) throw new Error('Child write check unavailable');
  fresh.include(`participation-${childConversationId}`);
  await conversationParticipation(options, memberId, childConversationId, fresh.deadline, 'post');
  if (await participationClosed(options.store, options.silo, childConversationId,
    fresh.deadline)) throw new ChildRequestClosed('Conversation closed');
  const source = messagePostedDataSchema.parse(loaded.source.event.data);
  const text = inputText(options, loaded.input.conversationId, source);
  options.keys.provision(options.silo, childConversationId);
  const encrypted = options.keys.encrypt(options.silo, childConversationId, text);
  const data = { conversationId: childConversationId, authorId: memberId,
    authorKind: 'human', contentType: source.contentType, ...encrypted };
  function verifyInput(row: StoredEvent, expected: StoredEvent['event']) {
    const parsed = messagePostedDataSchema.safeParse(row.event.data);
    if (!parsed.success || inputText(options, childConversationId, parsed.data) !== text ||
        !isDeepStrictEqual(row.event.correlation, {})) {
      throw new ChildRequestChanged('Child input changed');
    }
    // Compare the text separately because encryption creates a new ciphertext each time.
    const comparedData = { ...parsed.data, ciphertext: encrypted.ciphertext };
    const compared = { ...row, event: { ...row.event, data: comparedData } };
    verifySaved(compared, expected);
  }
  function isFirstInput(row: StoredEvent) {
    return row.event.id === firstInputId;
  }
  const previous = rows.find(isFirstInput);
  const subject = `conversation-${childConversationId}`;
  if (previous) {
    const expected = { ...previous.event, id: firstInputId, commandId: firstInputId,
      subject, silo: options.silo, type: 'message.posted', source: 'opencrane-server', data,
      principal: { kind: 'human' as const, id: memberId } };
    verifyInput(previous, expected);
    await fresh();
    return previous;
  }
  return save(options, memberId, firstInputId, subject, 'message.posted', data,
    creation.sequence, fresh, verifyInput);
}

export async function retryChildRequest(options: Options, memberId: string,
  conversationId: string, requestId: string, value: unknown) {
  try {
    return await saveRetry(options, memberId, conversationId, requestId, value);
  } catch (error) {
    if (!(error instanceof ChildRequestRace)) throw error;
    return saveRetry(options, memberId, conversationId, requestId, value);
  }
}
async function saveRetry(options: Options, memberId: string,
  conversationId: string, requestId: string, value: unknown) {
  const retry = childRetryInputSchema.parse(value);
  const intent = await retryIntent(options, memberId, conversationId, requestId);
  function participantId(join: ChildRequest['initialJoins'][number]) {
    return join.participantId;
  }
  const participantIds = intent.initialJoins.map(participantId);
  const input = { conversationId, requestId, participantIds,
    sourceMessageId: intent.sourceMessageId, assistantId: intent.assistantId,
    payingGroupId: intent.payingGroupId, allowanceBoundCents: intent.allowanceBoundCents };
  const loaded = await load(options, memberId, input);
  const saved = savedIntent(options, memberId, loaded);
  const retrying = { ...loaded, failed: false };
  const checked = await check(options, memberId, retrying, [memberId]);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([options.silo, conversationId, requestId, retry.retryId]));
  const id = `child-retry-${hash.digest('hex')}`;
  const subject = `conversation-${conversationId}`;
  let previous: StoredEvent | undefined;
  for (const row of loaded.rows) {
    if (row.event.type !== 'conversation.child_retry_requested') continue;
    const event = childRetryRequestedEventSchema.parse(row.event);
    if (event.data.requestId !== requestId) continue;
    if (event.data.retryId === retry.retryId) {
      const data = { ...event.data, ...retry, conversationId, requestId };
      const expected = { ...event, id, commandId: id, data, subject, silo: options.silo,
        principal: { kind: 'human' as const, id: memberId } };
      verifySaved(row, expected);
      return data;
    }
    if (event.data.failureEventId === retry.failureEventId) previous = row;
  }
  const current = childStartState(loaded.rows, saved.row.event.id);
  const failed = current.failure;
  if (previous && !failed) {
    const receipt = childRetryRequestedDataSchema.parse(previous.event.data);
    if (receipt.attempt === current.attempt) return receipt;
  }
  if (!failed || failed.id !== retry.failureEventId || failed.data.attempt >= 3) {
    throw new ChildRequestChanged('Child retry unavailable');
  }
  const data = { conversationId, requestId, ...retry, attempt: failed.data.attempt + 1 };
  const receipt = await save(options, memberId, id, subject, 'conversation.child_retry_requested',
    data, loaded.sequence, checked.fresh);
  return childRetryRequestedDataSchema.parse(receipt.event.data);
}

async function retryIntent(options: Options, memberId: string,
  conversationId: string, requestId: string) {
  const rows = await chatHistory(options.store, options.silo, conversationId);
  let intent: ChildRequest | undefined;
  for (const row of rows) {
    if (row.event.type !== 'conversation.child_requested') continue;
    const event = childRequestedEventSchema.parse(row.event);
    if (event.data.requestId === requestId) intent = event.data;
  }
  if (!intent || intent.createdBy !== memberId) refused();
  return intent;
}
