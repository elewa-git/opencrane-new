import { agentCommandRanDataSchema } from '@opencrane/events';
import { z } from 'zod';
import { conversationCreatedDataSchema, fileUploadedDataSchema,
  readConversationProse, childResultPublishedDataSchema } from '@opencrane/events';
import { chatRowSchema } from '@opencrane/protocol';
import { ChatRefused } from './access.ts';
import { isPublicChatId } from './public-id.ts';

const rowDisplayData = chatRowSchema.shape.data.strip();
const displayData = rowDisplayData.extend({
  conversationId: z.string().optional(), participantId: z.string().optional(),
  fileId: z.string().optional(), name: z.string().optional(), size: z.number().optional(),
  mime: z.string().optional(), sha256: z.string().optional(),
  uploadedBy: z.string().optional(), screenshot: fileUploadedDataSchema.shape.screenshot,
  changeType: z.string().optional(),
  executionMode: z.enum(['restricted', 'memory_free']).optional(),
  attachmentIds: z.array(z.string()).optional(),
});
const displayTypes = new Set([
  'participant.added', 'participant.removed', 'conversation.closed', 'message.posted',
  'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested',
  'agent.output_lost', 'agent.reasoning_summarised', 'agent.command_ran', 'agent.file_changed',
  'agent.tool_call_started', 'agent.tool_call_finished', 'agent.native_consent_refused',
  'agent.message_delta', 'agent.message_completed', 'file.uploaded', 'file.rejected',
  'file.delivered', 'tool.dispatch_recorded', 'decision.recorded',
]);
const proseTypes = new Set([
  'conversation.child_result_published', 'message.posted', 'agent.message_delta',
  'agent.message_completed', 'agent.reasoning_summarised',
]);

// Select display fields explicitly. Saved access references are not chat content.
export function chatDisplayData(type: string, input: unknown) {
  if (typeof input === 'object' && input !== null && 'conversationId' in input &&
      typeof input.conversationId === 'string' && !isPublicChatId(input.conversationId)) {
    throw new ChatRefused('Conversation unavailable');
  }
  if (type === 'conversation.child_result_published') {
    const saved = childResultPublishedDataSchema.parse(input);
    return { authorId: saved.publishedBy, publicationKind: saved.publicationKind,
      contentType: saved.contentType, text: saved.utterance };
  }
  if (type === 'conversation.created') {
    const created = conversationCreatedDataSchema.parse(input);
    if ('routinePreparation' in created && created.routinePreparation !== undefined) {
      throw new ChatRefused('Conversation unavailable');
    }
    if (!('contextKind' in created)) return created;
    const { conversationId, mode, assistantId, createdBy, payingGroupId } = created;
    return { conversationId, mode, assistantId, createdBy, payingGroupId };
  }
  // Require a safe display contract before a new event can enter an HTTP or socket reply.
  if (!displayTypes.has(type)) throw new Error('Chat display unavailable');
  const display = displayData.parse(input);
  if (hasDisplayText(type)) return { ...display, text: readConversationProse(input) };
  if (type === 'agent.command_ran') {
    const command = agentCommandRanDataSchema.parse(input);
    return { ...display, preview: command.view?.preview };
  }
  return display;
}

export function hasDisplayText(type: string) {
  return proseTypes.has(type);
}
