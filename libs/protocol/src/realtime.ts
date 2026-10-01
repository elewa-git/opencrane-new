import { z } from 'zod';

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const subscribeSchema = z.object({
  type: z.literal('subscribe'), topic: z.literal('members'), since: position, generation: generation.optional(),
}).strict();
export const memberStateSchema = z.object({
  memberId: z.string(), email: z.string(), displayName: z.string().nullable(),
  role: z.enum(['owner', 'admin', 'member']), status: z.enum(['invited', 'joined', 'removed']),
}).strict();
const envelope = { version: z.literal(1), topic: z.literal('members'), position, generation };
export const realtimeMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('member'), member: memberStateSchema }).strict(),
  z.object({ ...envelope, type: z.literal('ready') }).strict(),
  z.object({ ...envelope, type: z.literal('resync') }).strict(),
  z.object({ ...envelope, type: z.literal('refused') }).strict(),
]);
export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;
