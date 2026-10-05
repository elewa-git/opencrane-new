import type { EventStore, StoredEvent } from '@opencrane/event-store';
import {
  getEventDefinition,
  fileDeliveredDataSchema,
  fileUploadedDataSchema,
} from '@opencrane/events';
import { z } from 'zod';
import { creationEvent } from '../chat/private-session.ts';
import { chatHistory } from '../chat/commands.ts';
import { FileRefusal, parseFileInput } from './refusals.ts';

const conversationDetails = z.object({
  createdBy: z.string(),
  assistantId: z.string(),
  mode: z.string().default('agent_session'),
});
const participantDetails = z.object({ participantId: z.string() });
const memberDetails = z.object({ memberId: z.string() });
const fileContext = z.object({
  conversationId: z.string(),
  screenshot: z.unknown().optional(),
});

export async function ownConversation(
  store: Pick<EventStore, 'readStream'>,
  silo: string,
  conversationId: string,
  memberId: string,
  allowParticipant = false,
  uploading = false,
) {
  const rows = await chatHistory(store, silo, conversationId);
  await verifyCurrentMember(store, silo, memberId);
  const created = findEventOfType(rows, 'conversation.created');
  const data = conversationDetails.parse(created?.event.data);
  const event = await creationEvent(store, silo, `assistant-${data.assistantId}`,
    'assistant.created');
  const assistant = z.object({ kind: z.string(), ownerId: z.string() }).parse(event.data);
  if (assistant.kind === 'team') {
    await requireTeamSession(store, silo, assistant.ownerId, data.createdBy, memberId);
    if (uploading) throw new FileRefusal('team_files_refused');
    allowParticipant = false;
  }
  let allowed = data.createdBy === memberId;
  if (allowParticipant) {
    allowed = currentParticipant(rows, memberId, allowed);
  }
  const closed = findEventOfType(rows, 'conversation.closed');
  if (!allowed || data.mode !== 'agent_session' || closed) {
    throw new FileRefusal('conversation_refused');
  }
  return rows;
}

async function requireTeamSession(store: Pick<EventStore, 'readStream'>, silo: string,
  groupId: string, creatorId: string, memberId: string) {
  if (creatorId !== memberId) throw new FileRefusal('conversation_refused');
  let member = false;
  for await (const row of store.readStream(`team-${groupId}`)) {
    if (row.event.silo !== silo) throw new FileRefusal('conversation_refused');
    if (!['team.member_added', 'team.member_removed'].includes(row.event.type)) continue;
    const membership = memberDetails.parse(row.event.data);
    if (membership.memberId === memberId) member = row.event.type === 'team.member_added';
  }
  if (!member) throw new FileRefusal('conversation_refused');
}

async function verifyCurrentMember(
  store: Pick<EventStore, 'readStream'>,
  silo: string,
  memberId: string,
) {
  let removed = false;
  for await (const row of store.readStream(`member-${memberId}`)) {
    if (row.event.silo !== silo) {
      throw new FileRefusal('conversation_refused');
    }
    removed = row.event.type === 'member.removed';
  }
  if (removed) {
    throw new FileRefusal('conversation_refused');
  }
}

function findEventOfType(rows: StoredEvent[], type: string) {
  for (const row of rows) {
    if (row.event.type === type) {
      return row;
    }
  }
  return undefined;
}

function currentParticipant(rows: StoredEvent[], memberId: string, isOwner: boolean) {
  let participates = isOwner;
  for (const { event } of rows) {
    if (event.type !== 'participant.added' && event.type !== 'participant.removed') {
      continue;
    }
    const participant = participantDetails.parse(event.data);
    if (participant.participantId === memberId) {
      participates = event.type === 'participant.added';
    }
  }
  return participates;
}

/** Only writes one conditional append. Storage and delivery are IO reactions. */
export async function fileCommand(
  store: Pick<EventStore, 'readStream' | 'append'>,
  silo: string,
  memberId: string,
  eventId: string,
  type: 'file.uploaded' | 'file.rejected' | 'file.delivered',
  value: unknown,
  fresh?: () => Promise<void>,
) {
  const definition = getEventDefinition(type)!;
  const data = parseFileInput(definition.dataSchema, value);
  const context = fileContext.parse(data);
  const allowParticipant = type === 'file.delivered' || context.screenshot !== undefined;
  const rows = await ownConversation(
    store, silo, context.conversationId, memberId, allowParticipant, true,
  );
  if (type === 'file.delivered') {
    verifyDelivery(rows, data, memberId);
  }
  const previous = findEventById(rows, eventId);
  if (previous) {
    verifyRetry(previous, type, data, memberId);
    return { status: 'appended' as const, sequence: previous.sequence };
  }
  await fresh?.();
  const event = {
    id: eventId,
    commandId: eventId,
    silo,
    subject: `conversation-${context.conversationId}`,
    type,
    data,
    principal: { kind: 'human' as const, id: memberId },
    source: 'opencrane-server',
    time: new Date().toISOString(),
  };
  const append = { expectedSequence: rows.at(-1)?.sequence ?? 0, event };
  const result = await store.append(append);
  if (result.status === 'appended') {
    const savedRows = await chatHistory(store, silo, context.conversationId);
    const saved = findEventById(savedRows, eventId);
    // A concurrent retry may have won the append; its data must still match.
    const changedData = JSON.stringify(saved?.event.data) !== JSON.stringify(data);
    if (!saved || saved.event.type !== type || changedData) {
      throw new FileRefusal('id_reused');
    }
  }
  return result;
}

function findEventById(rows: StoredEvent[], eventId: string) {
  for (const row of rows) {
    if (row.event.id === eventId) {
      return row;
    }
  }
  return undefined;
}

function verifyRetry(previous: StoredEvent, type: string, data: unknown, memberId: string) {
  const wrongType = previous.event.type !== type;
  const wrongMember = previous.event.principal?.id !== memberId;
  const changedData = JSON.stringify(previous.event.data) !== JSON.stringify(data);
  if (wrongType || wrongMember || changedData) {
    throw new FileRefusal('id_reused');
  }
}

function verifyDelivery(rows: StoredEvent[], data: unknown, memberId: string) {
  const delivery = fileDeliveredDataSchema.parse(data);
  let upload: z.infer<typeof fileUploadedDataSchema> | undefined;
  for (const row of rows) {
    if (row.event.type !== 'file.uploaded') {
      continue;
    }
    const file = fileUploadedDataSchema.parse(row.event.data);
    if (file.fileId === delivery.fileId) {
      upload = file;
      break;
    }
  }
  if (!upload || upload.sha256 !== delivery.sha256 || upload.uploadedBy !== memberId) {
    throw new FileRefusal('delivery_refused');
  }
}
