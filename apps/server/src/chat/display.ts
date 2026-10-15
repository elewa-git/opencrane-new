import { z } from 'zod';
import { conversationCreatedDataSchema, fileUploadedDataSchema,
  childResultPublishedDataSchema } from '@opencrane/events';
import { chatRowSchema } from '@opencrane/protocol';

const rowDisplayData = chatRowSchema.shape.data.strip();
const displayData = rowDisplayData.extend({
  conversationId: z.string().optional(), participantId: z.string().optional(),
  fileId: z.string().optional(), name: z.string().optional(), size: z.number().optional(),
  mime: z.string().optional(), sha256: z.string().optional(),
  uploadedBy: z.string().optional(), screenshot: fileUploadedDataSchema.shape.screenshot,
  changeType: z.string().optional(),
  executionMode: z.enum(['restricted', 'memory_free']).optional(),
});
const displayTypes = new Set([
  'participant.added', 'participant.removed', 'conversation.closed', 'message.posted',
  'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested',
  'agent.output_lost', 'agent.reasoning_summarised', 'agent.command_ran', 'agent.file_changed',
  'agent.tool_call_started', 'agent.tool_call_finished', 'agent.native_consent_refused',
  'agent.message_delta', 'agent.message_completed', 'file.uploaded', 'file.rejected',
  'file.delivered', 'tool.dispatch_recorded', 'decision.recorded',
]);
const encryptedTextTypes = new Set([
  'conversation.child_result_published', 'message.posted', 'agent.message_delta',
  'agent.message_completed', 'agent.reasoning_summarised',
]);

// Select display fields before decrypting. Saved access references are not chat content.
export function chatDisplayData(type: string, input: unknown) {
  if (type === 'conversation.child_result_published') {
    const saved = childResultPublishedDataSchema.parse(input);
    return { authorId: saved.publishedBy, publicationKind: saved.publicationKind,
      contentType: saved.contentType };
  }
  if (type === 'conversation.created') {
    const created = conversationCreatedDataSchema.parse(input);
    if (!('contextKind' in created)) return created;
    const { conversationId, mode, assistantId, createdBy, payingGroupId } = created;
    return { conversationId, mode, assistantId, createdBy, payingGroupId };
  }
  // Require a safe display contract before a new event can enter an HTTP or socket reply.
  if (!displayTypes.has(type)) throw new Error('Chat display unavailable');
  return displayData.parse(input);
}

export function hasDisplayText(type: string) {
  return encryptedTextTypes.has(type);
}
