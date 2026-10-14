import { z } from 'zod';
import { conversationEventId, type EventEnvelope } from '@opencrane/events';
import { readStreamSummary, type StoredEvent, type SummaryKind } from '@opencrane/event-store';
import { memberAuthorisation } from '@opencrane/authz';
import { conversationAccessFence, envelope, isAuthorityChanged } from '@opencrane/models';
import { activeChatMember, conversationParticipation, ChatRefused,
  type ChatOptions } from './access.ts';
import { inheritedChildSubjects } from './child-access.ts';
import { conversationClosed } from './participation.ts';
import { ChatConflict } from './commands.ts';
import { chatParticipantCommandSchema } from '@opencrane/protocol';

type Input = z.infer<typeof chatParticipantCommandSchema>;
type Access = Awaited<ReturnType<typeof conversationParticipation>>;
type Commands = Map<string, number>;

function emptyCommands(): Commands {
  return new Map();
}
function addCommand(commands: Commands, row: StoredEvent) {
  const conversationId = conversationEventId(row.event);
  if (row.event.subject !== `participation-${conversationId}`) {
    throw new Error('Participant command subject changed');
  }
  commands.set(row.event.id, row.sequence);
}
function commandCount(commands: Commands) {
  return commands.size;
}
const commandsKind: SummaryKind<Commands> = {
  name: 'participant-commands', keep: 64, empty: emptyCommands, add: addCommand,
  budget: { limit: 8192, size: commandCount },
};

function requireParticipantConversation(access: Access) {
  if (access.created.mode === 'group' || 'contextKind' in access.created) return;
  throw new ChatRefused('Group or shared child conversation required');
}

function requireHistoryReview(input: Input, access: Access) {
  if ('contextKind' in access.created) {
    if (input.action === 'add') {
      let acknowledged: unknown;
      if ('historyReleaseAcknowledged' in input) acknowledged = input.historyReleaseAcknowledged;
      z.literal(true).parse(acknowledged);
    }
  } else if ('historyReleaseAcknowledged' in input) {
    z.never().parse(input.historyReleaseAcknowledged);
  }
}

export async function participantList(options: ChatOptions, memberId: string,
  conversationId: string) {
  const access = await conversationParticipation(options, memberId, conversationId);
  requireParticipantConversation(access);
  const result = await options.db.query<{ member_id: string; display_name: string | null }>(
    'SELECT member_id, display_name FROM members WHERE silo = $1 AND member_id = ANY($2)',
    [options.silo, access.participantIds]);
  const names = new Map<string, string | null>();
  for (const row of result.rows) names.set(row.member_id, row.display_name);
  function person(participantId: string) {
    return { memberId: participantId, displayName: names.get(participantId) ?? null };
  }
  const rows = access.participantIds.map(person);
  const creator = access.created.createdBy === memberId;
  return { rows, joinPosition: access.joinPosition, accessPosition: access.accessPosition,
    canManage: creator, canLeave: !creator };
}

function participantData(input: Input, memberId: string, conversationId: string, access: Access) {
  let childFields;
  if ('contextKind' in access.created) {
    childFields = { contextKind: 'shared_child', reviewPosition: input.expectedAccessPosition };
  }
  if (input.action === 'add') {
    const data = { conversationId, participantId: input.participantId, addedBy: memberId };
    if (childFields) return { ...data, ...childFields, joinKind: 'explicit_child' };
    return data;
  }
  let participantId = memberId;
  if (input.action === 'remove') participantId = input.participantId;
  return { conversationId, participantId, removedBy: memberId, ...childFields };
}

function verifyRetry(row: StoredEvent, event: EventEnvelope) {
  const previous = row.event;
  const fields = z.record(z.string(), z.unknown()).parse(previous.data);
  const wanted = z.record(z.string(), z.unknown()).parse(event.data);
  if (previous.id !== event.id || previous.silo !== event.silo ||
      previous.subject !== event.subject || previous.type !== event.type ||
      previous.principal?.kind !== 'human' || previous.principal.id !== event.principal?.id) {
    throw new ChatConflict('Participant command id reused');
  }
  for (const key of Object.keys(wanted)) {
    if (fields[key] !== wanted[key]) throw new ChatConflict('Participant command id reused');
  }
}

async function requireParticipantAction(options: ChatOptions, memberId: string,
  conversationId: string, input: Input, access: Access) {
  requireParticipantConversation(access);
  const targetId = participantData(input, memberId, conversationId, access).participantId;
  const selfRemoval = input.action !== 'add' && targetId === memberId;
  if (targetId === access.created.createdBy && input.action !== 'add') {
    throw new ChatRefused('The creator must remain in the conversation');
  }
  if (selfRemoval) return;
  if (access.created.createdBy !== memberId) throw new ChatRefused('Creator required');
  const auth = memberAuthorisation(options.binding);
  const permission = await auth.conversation(memberId, conversationId, 'manage_participants');
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) throw new ChatRefused('Participant management refused');
}

function validateEdit(access: Access, input: Input, memberId: string) {
  if (access.accessPosition !== input.expectedAccessPosition) {
    throw new ChatConflict('Participants changed; reload before editing');
  }
  const targetId = input.action === 'leave' ? memberId : input.participantId;
  const present = access.participantIds.includes(targetId);
  if (input.action === 'add') {
    if (present || access.participantIds.length >= 97) {
      throw new ChatConflict('Participant cannot be added');
    }
  } else if (!present) {
    throw new ChatConflict('Participant is already absent');
  }
}

async function confirmParticipantAccess(fresh: Awaited<ReturnType<typeof conversationAccessFence>>) {
  try {
    await fresh();
  } catch (error) {
    if (isAuthorityChanged(error)) {
      throw new ChatConflict('Participants or membership changed; reload before editing');
    }
    throw error;
  }
}

export async function participantCommand(options: ChatOptions, memberId: string,
  conversationId: string, value: unknown) {
  const input = chatParticipantCommandSchema.parse(value);
  const subject = `participation-${conversationId}`;
  const deadline = performance.now() + 10_000;
  const access = await conversationParticipation(options, memberId, conversationId, deadline);
  requireParticipantConversation(access);
  requireHistoryReview(input, access);
  function commandPosition(commands: Commands, sequence: number) {
    return { previous: commands.get(input.id), sequence };
  }
  const facts = await readStreamSummary(options.store, options.silo, subject,
    commandsKind, deadline, commandPosition);
  const data = participantData(input, memberId, conversationId, access);
  const type = input.action === 'add' ? 'participant.added' : 'participant.removed';
  const event = envelope(options.silo, subject, type, data, input.id);
  event.commandId = input.id;
  event.source = 'opencrane-server';
  event.principal = { kind: 'human', id: memberId };
  let previous: StoredEvent | undefined;
  if (facts.previous !== undefined) {
    previous = await options.store.readEvent(facts.previous, deadline);
    verifyRetry(previous, event);
  }
  await requireParticipantAction(options, memberId, conversationId, input, access);
  // Load cold close and target histories before starting the short write check.
  await conversationClosed(options.store, options.db, options.silo, conversationId, deadline);
  if (!previous) validateEdit(access, input, memberId);
  if (!previous && input.action === 'add') {
    await activeChatMember(options, input.participantId);
  }
  const subjects = [`member-${memberId}`, subject];
  subjects.push(...inheritedChildSubjects(access));
  if (!previous && input.action === 'add') subjects.push(`member-${input.participantId}`);
  const fresh = await conversationAccessFence(options.store, performance.now(), subjects);
  const current = await conversationParticipation(options, memberId, conversationId,
    fresh.deadline);
  await requireParticipantAction(options, memberId, conversationId, input, current);
  if (previous) {
    await confirmParticipantAccess(fresh);
    return { status: 'appended' as const, sequence: previous.sequence };
  }
  validateEdit(current, input, memberId);
  if (await conversationClosed(options.store, options.db, options.silo,
    conversationId, fresh.deadline)) throw new ChatConflict('Conversation is closed');
  if (input.action === 'add') await activeChatMember(options, input.participantId, fresh);
  await confirmParticipantAccess(fresh);
  const command = { event, expectedSequence: facts.sequence, historyChecked: true as const,
    deadline: fresh.deadline };
  const result = await options.store.append(command);
  if (result.status === 'appended') {
    const saved = await options.store.readEvent(result.sequence);
    verifyRetry(saved, event);
  }
  return result;
}
