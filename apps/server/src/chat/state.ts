import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { conversationArchiveSetDataSchema, conversationReadAdvancedDataSchema,
  parseEventByType, type EventEnvelope } from '@opencrane/events';
import { readStreamSummary, type StoredEvent, type SummaryKind } from '@opencrane/event-store';
import { conversationAccessFence } from '@opencrane/models';
import { chatStateCommandSchema } from '@opencrane/protocol';
import { activeChatMember, conversationParticipation, type ChatOptions } from './access.ts';
import { privateSessionCreation, requirePrivateReader } from './private-session.ts';
import { ChatConflict } from './commands.ts';

type Input = z.infer<typeof chatStateCommandSchema>;
type Archive = { archived: boolean; position: number };
type Summary = { commands: Map<string, number>; archives: Map<string, Archive> };
const preferenceData = conversationArchiveSetDataSchema.or(conversationReadAdvancedDataSchema);
const listState = z.object({ archived: z.boolean(), archivePosition: z.int().nonnegative(),
  throughPosition: z.int().nonnegative(), throughEventId: z.string().optional() }).nullable();

export function listPreference(joinEventId: string, value: unknown) {
  const state = listState.parse(value);
  return { joinEventId, archived: state?.archived ?? false,
    archivePosition: state?.archivePosition ?? 0, throughPosition: state?.throughPosition ?? 0,
    throughEventId: state?.throughEventId };
}

function joinKey(conversationId: string, joinEventId: string) {
  return JSON.stringify([conversationId, joinEventId]);
}
function emptyState(): Summary {
  return { commands: new Map(), archives: new Map() };
}
function addState(summary: Summary, row: StoredEvent) {
  const event = row.event;
  if (!parseEventByType(event).success) throw new Error('Invalid saved preference');
  const data = preferenceData.parse(event.data);
  summary.commands.set(z.string().parse(event.commandId), row.sequence);
  if ('archived' in data) {
    const archive = { archived: data.archived, position: row.sequence };
    summary.archives.set(joinKey(data.conversationId, data.joinEventId), archive);
  }
}
function stateSize(summary: Summary) {
  return summary.commands.size * 256 + summary.archives.size * 512;
}
const stateKind: SummaryKind<Summary> = {
  name: 'chat-preferences', keep: 64, empty: emptyState, add: addState,
  budget: { limit: 8 * 1024 * 1024, size: stateSize },
};

function stateFacts(options: ChatOptions, memberId: string, conversationId: string,
  joinEventId: string, commandId: string, deadline: number) {
  function take(summary: Summary, sequence: number) {
    const archive = summary.archives.get(joinKey(conversationId, joinEventId));
    return { sequence, previous: summary.commands.get(commandId),
      archive: archive ?? { archived: false, position: 0 } };
  }
  return readStreamSummary(options.store, options.silo, `chat-state-${memberId}`,
    stateKind, deadline, take);
}

function preferenceEvent(options: ChatOptions, memberId: string,
  conversationId: string, input: Input): EventEnvelope {
  const id = preferenceId(options.silo, memberId, input.id);
  // Keep the expected position too, so changing any command field cannot reuse its id.
  const request = preferenceHash(input);
  const common = { conversationId, memberId, joinEventId: input.joinEventId };
  let type: string;
  let data: z.infer<typeof preferenceData>;
  if (input.action === 'archive') {
    type = 'conversation.archive_set';
    data = { ...common, archived: input.archived };
  } else {
    type = 'conversation.read_advanced';
    data = { ...common, throughPosition: input.throughPosition,
      throughEventId: input.throughEventId };
  }
  return { id, commandId: input.id, type, data, silo: options.silo,
    subject: `chat-state-${memberId}`, source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human', id: memberId }, correlation: { request } };
}

function preferenceId(silo: string, memberId: string, commandId: string) {
  const identity = [silo, memberId, commandId];
  return preferenceHash(identity);
}
function preferenceHash(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}

function verifyRetry(saved: StoredEvent, expected: EventEnvelope) {
  const event = saved.event;
  if (event.id !== expected.id || event.commandId !== expected.commandId ||
      event.silo !== expected.silo || event.subject !== expected.subject ||
      event.source !== expected.source ||
      event.type !== expected.type || !isDeepStrictEqual(event.principal, expected.principal) ||
      !isDeepStrictEqual(event.data, expected.data) ||
      event.correlation.request !== expected.correlation.request) {
    throw new ChatConflict('Preference command id reused');
  }
}

async function verifyRead(options: ChatOptions, conversationId: string,
  input: Extract<Input, { action: 'read' }>, historyPosition: number, deadline: number) {
  if (input.throughPosition < historyPosition) throw new ChatConflict('Read precedes this join');
  // Accept only a row that the history reader can already return to this device.
  const visible = await options.db.query<{ event_id: string }>(
    `SELECT event_id FROM conversation_feed
      WHERE silo=$1 AND conversation_id=$2 AND position=$3 AND event_id=$4`,
    [options.silo, conversationId, input.throughPosition, input.throughEventId]);
  if (!visible.rows[0]) throw new ChatConflict('Read row is not available');
  const row = await options.store.readEvent(input.throughPosition, deadline);
  const data = z.object({ conversationId: z.string() }).safeParse(row.event.data);
  const subjects = [`conversation-${conversationId}`, `participation-${conversationId}`];
  if (row.sequence !== input.throughPosition || row.event.silo !== options.silo ||
      row.event.id !== input.throughEventId || !subjects.includes(row.event.subject) ||
      !data.success || data.data.conversationId !== conversationId) {
    throw new ChatConflict('Read reference changed');
  }
}

async function preferenceWriteAccess(options: ChatOptions, memberId: string,
  conversationId: string, input: Input,
  session: Awaited<ReturnType<typeof privateSessionCreation>> | undefined, deadline: number) {
  const subjects = [`member-${memberId}`, `participation-${conversationId}`];
  if (session) {
    subjects.push(`assistant-${session.created.assistantId}`);
    if (session.assistant.kind === 'team') subjects.push(`team-${session.assistant.ownerId}`);
  }
  const fresh = await conversationAccessFence(options.store, performance.now(), subjects, deadline);
  await activeChatMember(options, memberId, fresh);
  const current = await conversationParticipation(options, memberId, conversationId, fresh.deadline);
  if (current.joinEventId !== input.joinEventId) throw new ChatConflict('Conversation join changed');
  if (session) await requirePrivateReader(options, memberId, session);
  await fresh();
  return fresh;
}

export async function stateCommand(options: ChatOptions, memberId: string,
  conversationId: string, value: unknown) {
  const input = chatStateCommandSchema.parse(value);
  const deadline = performance.now() + 10_000;
  const access = await conversationParticipation(options, memberId, conversationId, deadline);
  if (access.joinEventId !== input.joinEventId) throw new ChatConflict('Conversation join changed');
  let session: Awaited<ReturnType<typeof privateSessionCreation>> | undefined;
  if (access.created.mode === 'agent_session') {
    session = await privateSessionCreation(options, conversationId, access.creation.event);
    await requirePrivateReader(options, memberId, session);
  }
  if (input.action === 'read') {
    await verifyRead(options, conversationId, input, access.historyPosition, deadline);
  }
  const event = preferenceEvent(options, memberId, conversationId, input);
  for (let attempt = 0; attempt < 3; attempt++) {
    const facts = await stateFacts(options, memberId, conversationId,
      input.joinEventId, input.id, deadline);
    let previous: StoredEvent | undefined;
    if (facts.previous !== undefined) {
      previous = await options.store.readEvent(facts.previous, deadline);
      verifyRetry(previous, event);
    }
    if (!previous && input.action === 'archive' &&
        input.expectedArchivePosition !== facts.archive.position &&
        input.archived !== facts.archive.archived) {
      throw new ChatConflict('Archive choice changed');
    }
    const fresh = await preferenceWriteAccess(options, memberId, conversationId, input,
      session, deadline);
    if (previous) return { status: 'appended' as const, sequence: previous.sequence };
    const command = { event, expectedSequence: facts.sequence, historyChecked: true as const,
      deadline: fresh.deadline };
    const result = await options.store.append(command);
    if (result.status === 'conflict') continue;
    if (result.status === 'appended') {
      const saved = await options.store.readEvent(result.sequence, deadline);
      verifyRetry(saved, event);
    }
    return result;
  }
  throw new ChatConflict('Preference changed; retry the original command');
}

export async function stateChange(options: ChatOptions, memberId: string,
  conversationId: string, commandId: string, joinEventId: string) {
  const deadline = performance.now() + 10_000;
  const facts = await stateFacts(options, memberId, conversationId, joinEventId, commandId, deadline);
  if (facts.previous === undefined) return undefined;
  const saved = await options.store.readEvent(facts.previous, deadline);
  const event = saved.event;
  const data = preferenceData.parse(event.data);
  if (event.id !== preferenceId(options.silo, memberId, commandId) ||
      event.silo !== options.silo || event.subject !== `chat-state-${memberId}` ||
      event.commandId !== commandId || event.principal?.kind !== 'human' ||
      event.principal.id !== memberId || data.memberId !== memberId ||
      data.conversationId !== conversationId || data.joinEventId !== joinEventId) return undefined;
  const checkpoint = await options.db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name='conversations'");
  let content = 'applying';
  if (Number(checkpoint.rows[0]?.sequence) >= saved.sequence) content = 'current';
  return { status: 'appended' as const, conversationId, commandId, type: event.type,
    sequence: saved.sequence, projection: { content, iam: 'current' } };
}
