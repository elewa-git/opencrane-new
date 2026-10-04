import type { EventStore } from '@opencrane/event-store';
import { getEventDefinition, fileDeliveredDataSchema, fileUploadedDataSchema } from '@opencrane/events';
import { z } from 'zod';
import { chatHistory } from '../chat/commands.ts';

export async function ownConversation(store: EventStore, silo: string, conversationId: string, memberId: string, allowParticipant = false) {
  const rows = await chatHistory(store, silo, conversationId);
  let removed = false;
  for await (const row of store.readStream(`member-${memberId}`)) {
    if (row.event.silo !== silo) throw new Error('Conversation refused');
    removed = row.event.type === 'member.removed';
  }
  if (removed) throw new Error('Conversation refused');
  const created = rows.find(row => row.event.type === 'conversation.created');
  const data = z.object({ createdBy: z.string(), mode: z.string().default('agent_session') }).parse(created?.event.data);
  let participates = data.createdBy === memberId;
  for (const { event } of rows) {
    if (['participant.added', 'participant.removed'].includes(event.type) && z.object({ participantId: z.string() }).parse(event.data).participantId === memberId) participates = event.type === 'participant.added';
  }
  if ((allowParticipant ? !participates : data.createdBy !== memberId) || data.mode !== 'agent_session' || rows.some(row => row.event.type === 'conversation.closed')) throw new Error('Conversation refused');
  return rows;
}
/** Only writes one conditional event append. Quarantine and delivery are IO reactions, outside this command. */
export async function fileCommand(store: EventStore, silo: string, memberId: string, id: string, type: 'file.uploaded' | 'file.rejected' | 'file.delivered', value: unknown, fresh?: () => Promise<void>) {
  const data = getEventDefinition(type)!.dataSchema.parse(value);
  const conversationId = z.object({ conversationId: z.string() }).parse(data).conversationId;
  const rows = await ownConversation(store, silo, conversationId, memberId, type === 'file.delivered' || z.object({ screenshot: z.unknown().optional() }).parse(data).screenshot !== undefined);
  if (type === 'file.delivered') verifyDelivery(rows, data, memberId);
  const previous = rows.find(row => row.event.id === id);
  if (previous) {
    if (previous.event.type !== type || previous.event.principal?.id !== memberId || JSON.stringify(previous.event.data) !== JSON.stringify(data)) throw new Error('Id reused');
    return { status: 'appended' as const, sequence: previous.sequence };
  }
  await fresh?.();
  const result = await store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event: { id, commandId: id, silo,
    subject: `conversation-${conversationId}`, type, data, principal: { kind: 'human', id: memberId }, source: 'opencrane-server', time: new Date().toISOString() } });
  if (result.status === 'appended') {
    const saved = (await chatHistory(store, silo, conversationId)).find(row => row.event.id === id);
    if (!saved || saved.event.type !== type || JSON.stringify(saved.event.data) !== JSON.stringify(data)) throw new Error('Id reused');
  }
  return result;
}

function verifyDelivery(rows: Awaited<ReturnType<typeof chatHistory>>, data: unknown, memberId: string) {
  const delivery = fileDeliveredDataSchema.parse(data);
  const upload = rows.filter(row => row.event.type === 'file.uploaded').map(row => fileUploadedDataSchema.parse(row.event.data)).find(file => file.fileId === delivery.fileId);
  if (!upload || upload.sha256 !== delivery.sha256 || upload.uploadedBy !== memberId) throw new Error('File delivery refused');
}
