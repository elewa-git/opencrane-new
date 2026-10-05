import { z } from 'zod';
export const chatSubscribeSchema = z.object({ type: z.literal('subscribe'), topic: z.literal('conversation'),
  conversationId: z.string().regex(/^[\w-]{1,200}$/u), since: z.int().nonnegative(), generation: z.int().nonnegative().optional() }).strict();
// Browser reads validate creation modes while future message fields remain opaque.
const createdIdentity = { conversationId: z.string(), createdBy: z.string() };
const creationSchema = z.union([
  z.object({
    ...createdIdentity, assistantId: z.string(),
    mode: z.literal('agent_session').default('agent_session'),
    payingGroupId: z.string().optional(),
  }).strict(),
  z.object({
    ...createdIdentity, mode: z.literal('direct'), participantIds: z.array(z.string()).length(2),
  }).strict().refine(directParticipants),
]);
function validateCreationRow(row: { type: string; data: unknown }, context: z.RefinementCtx) {
  if (row.type !== 'conversation.created') return;
  const parsed = creationSchema.safeParse(row.data);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'Invalid conversation mode', path: ['data'] });
  }
}
export const chatRowSchema = z.object({ id: z.string(), position: z.int().nonnegative(), type: z.string(), time: z.string(),
  data: z.object({ text: z.string().optional(), turnId: z.string().optional(), messageId: z.string().optional(),
    authorId: z.string().optional(), path: z.string().optional(), exitCode: z.number().optional(), commandDigest: z.string().optional(),
    reason: z.string().optional(), contentType: z.string().optional() }).passthrough(),
}).superRefine(validateCreationRow);
export const chatMessageSchema = z.object({ version: z.literal(1), topic: z.literal('conversation'), conversationId: z.string(),
  type: z.enum(['event', 'ready', 'resync', 'refused']), position: z.int().nonnegative(), generation: z.int().nonnegative(),
  row: chatRowSchema.optional(),
  computerState: z.string().optional(),
}).strict();

export const chatFeedSchema = z.object({ rows: z.array(chatRowSchema), position: z.int().nonnegative(), generation: z.int().nonnegative(), computerState: z.string() });
const conversationDisplay = {
  conversationId: z.string(), createdBy: z.string(), createdAt: z.string(),
  title: z.string().optional(),
  status: z.enum(['open', 'working', 'done', 'closed', 'failed', 'stopped']).optional(),
};
function directParticipants(row: { createdBy: string; participantIds: string[] }) {
  return row.participantIds[0] !== row.participantIds[1] &&
    row.participantIds.includes(row.createdBy);
}
export const chatListSchema = z.object({ rows: z.array(z.union([
  z.object({
    ...conversationDisplay, assistantId: z.string(), payingGroupId: z.string().optional(),
    mode: z.literal('agent_session').default('agent_session'),
  }).strict(),
  z.object({
    ...conversationDisplay, mode: z.literal('direct'),
    participantIds: z.array(z.string()).length(2),
  }).strict().refine(directParticipants),
])) });
export const chatColleaguesSchema = z.object({
  rows: z.array(z.object({ memberId: z.string(), displayName: z.string().nullable() }).strict()),
  next: z.string().nullable(),
}).strict();
export const chatChangeSchema = z.object({
  status: z.literal('appended'), conversationId: z.string(), commandId: z.string(),
  type: z.string(), sequence: z.int().positive(),
  projection: z.object({
    content: z.enum(['current', 'applying']), iam: z.enum(['current', 'applying']),
  }).strict(),
}).strict();
export const chatContextSchema = z.object({ memberId: z.string(), displayName: z.string().nullable().optional(), assistantId: z.string().nullable() });
export type ChatRow = z.infer<typeof chatRowSchema>;
export type ChatConversation = z.infer<typeof chatListSchema>['rows'][number];

/** A title is a display of the first message, never separately stored business state. */
export function sessionSlug(text: string): string {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 4).join('-').slice(0, 24).replace(/-+$/, '') || 'personal-session';
}
