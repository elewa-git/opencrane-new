import { z } from 'zod';
import { chatIdSchema, conversationCreatedDataSchema, hasDirectParticipants,
  toolDispatchRecordedDataSchema, agentNativeConsentRefusedDataSchema } from '@opencrane/events';
export const computerStateSchema = z.enum(['ready', 'starting', 'recovering', 'not_applicable']);
export type ComputerState = z.infer<typeof computerStateSchema>;
export const chatSubscribeSchema = z.object({ type: z.literal('subscribe'), topic: z.literal('conversation'),
  conversationId: chatIdSchema, since: z.int().nonnegative(), generation: z.int().nonnegative().optional() }).strict();
function validateCreationRow(row: { type: string; data: unknown }, context: z.RefinementCtx) {
  if (row.type !== 'conversation.created') return;
  const parsed = conversationCreatedDataSchema.safeParse(row.data);
  if (!parsed.success) {
    context.addIssue({ code: 'custom', message: 'Invalid conversation mode', path: ['data'] });
  }
}
const toolRowDataSchema = z.object({ status: z.enum(['completed', 'failed']).optional() });
const decisionRowDataSchema = z.object({ outcome: z.enum(['allow', 'ask', 'deny']).optional() });

function validateRowFields(row: { type: string; data: unknown }, context: z.RefinementCtx) {
  validateCreationRow(row, context);
  let fieldsSchema;
  if (row.type === 'agent.native_consent_refused') {
    fieldsSchema = agentNativeConsentRefusedDataSchema;
  } else if (row.type === 'tool.dispatch_recorded') {
    fieldsSchema = toolDispatchRecordedDataSchema;
  } else if (row.type === 'agent.tool_call_started' || row.type === 'agent.tool_call_finished') {
    fieldsSchema = toolRowDataSchema;
  } else if (row.type === 'decision.recorded') {
    fieldsSchema = decisionRowDataSchema;
  } else {
    return;
  }
  const parsed = fieldsSchema.safeParse(row.data);
  if (parsed.success) {
    return;
  }
  for (const issue of parsed.error.issues) {
    const rowIssue = { ...issue, path: ['data', ...issue.path] };
    context.addIssue(rowIssue);
  }
}

export const chatRowSchema = z.object({
  id: z.string(),
  position: z.int().nonnegative(),
  type: z.string(),
  time: z.string(),
  data: z.object({
    text: z.string().optional(),
    turnId: z.string().optional(),
    callId: z.string().optional(),
    nativeRequestId: z.string().optional(),
    serverName: z.string().optional(),
    serverId: z.string().optional(),
    toolName: z.string().optional(),
    status: z.string().optional(),
    durationMs: z.int().nonnegative().optional(),
    logicalRequestId: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
    evidence: z.enum(['connection_refused', 'response_received', 'transport_uncertain']).optional(),
    outcome: z.string().optional(),
    requestId: z.string().optional(),
    approvalId: z.string().optional(),
    messageId: z.string().optional(),
    authorId: z.string().optional(),
    path: z.string().optional(),
    exitCode: z.number().optional(),
    commandDigest: z.string().optional(),
    reason: z.string().optional(),
    contentType: z.string().optional(),
  }).passthrough(),
}).superRefine(validateRowFields);
export const chatMessageSchema = z.object({ version: z.literal(1), topic: z.literal('conversation'), conversationId: z.string(),
  type: z.enum(['event', 'ready', 'resync', 'refused']), position: z.int().nonnegative(), generation: z.int().nonnegative(),
  row: chatRowSchema.optional(),
  computerState: computerStateSchema.optional(),
  computerRecovered: z.boolean().optional(),
  computerLostAt: z.string().datetime().optional(),
}).strict();

export const chatFeedSchema = z.object({
  rows: z.array(chatRowSchema), position: z.int().nonnegative(), generation: z.int().nonnegative(),
  computerState: computerStateSchema, computerRecovered: z.boolean().optional(),
  computerLostAt: z.string().datetime().optional(),
});
export const memoryAdmissionSchema = z.object({
  state: z.literal('disabled'),
  failing: z.array(z.string()),
}).strict();
export type MemoryAdmission = z.infer<typeof memoryAdmissionSchema>;
const conversationDisplay = {
  conversationId: z.string(), createdBy: z.string(), createdAt: z.string(),
  title: z.string().optional(),
  status: z.enum(['open', 'working', 'done', 'closed', 'failed', 'stopped', 'lost']).optional(),
};
export const chatListSchema = z.object({ rows: z.array(z.union([
  z.object({
    ...conversationDisplay, assistantId: z.string(), payingGroupId: z.string().optional(),
    assistantKind: z.enum(['personal', 'team']).optional(),
    mode: z.literal('agent_session').default('agent_session'),
  }).strict(),
  z.object({
    ...conversationDisplay, mode: z.literal('direct'),
    participantIds: z.array(z.string()).length(2),
  }).strict().refine(hasDirectParticipants),
  z.object({
    ...conversationDisplay, mode: z.literal('group'), participantIds: z.array(z.string()),
    groupId: z.string().optional(), groupSnapshotPosition: z.int().nonnegative().optional(),
  }).strict(),
])) });
export const chatColleaguesSchema = z.object({
  rows: z.array(z.object({ memberId: z.string(), displayName: z.string().nullable() }).strict()),
  next: z.string().nullable(),
}).strict();
export const chatGroupsSchema = z.object({
  rows: z.array(z.object({ groupId: z.string(), name: z.string() }).strict()),
  next: z.string().nullable(),
}).strict();
export const chatGroupSnapshotSchema = z.object({
  groupId: z.string(), name: z.string(), position: z.int().nonnegative(),
  members: chatColleaguesSchema.shape.rows,
}).strict();
export const chatChangeSchema = z.object({
  status: z.literal('appended'), conversationId: z.string(), commandId: z.string(),
  type: z.string(), sequence: z.int().positive(),
  projection: z.object({
    content: z.enum(['current', 'applying']), iam: z.enum(['current', 'applying']),
  }).strict(),
}).strict();
export const chatContextSchema = z.object({
  memberId: z.string(), displayName: z.string().nullable().optional(),
  assistantId: z.string().nullable(), memoryAdmission: memoryAdmissionSchema.optional(),
});
export type ChatRow = z.infer<typeof chatRowSchema>;
export type ChatConversation = z.infer<typeof chatListSchema>['rows'][number];

/** A title is a display of the first message, never separately stored business state. */
export function sessionSlug(text: string): string {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 4).join('-').slice(0, 24).replace(/-+$/, '') || 'personal-session';
}


export const chatParticipantCommandSchema = z.union([
  z.strictObject({ id: chatIdSchema, action: z.enum(['add', 'remove']),
    participantId: chatIdSchema, expectedAccessPosition: z.int().nonnegative() }),
  z.strictObject({ id: chatIdSchema, action: z.literal('leave'),
    expectedAccessPosition: z.int().nonnegative() }),
]);
export const chatParticipantsSchema = z.strictObject({
  rows: z.array(z.strictObject({ memberId: chatIdSchema, displayName: z.string().nullable() })),
  joinPosition: z.int().positive(), accessPosition: z.int().positive(),
  canManage: z.boolean(), canLeave: z.boolean(),
});
