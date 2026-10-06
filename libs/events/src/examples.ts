// Keep these four example event schemas together. They share the field shapes in data.ts,
// and each other event type has its own strict schema there too.
import { z } from 'zod';
import { centsSchema, ciphertextSchema, keyIdSchema } from './data.ts';

// member.joined — an invitation was accepted and someone became a member.
// docs/architecture/events.md: "OpenFGA `member`; emit `assistant.created`".
export const memberJoinedDataSchema = z
  .object({
    memberId: z.string().min(1),
    email: z.email(),
    displayName: z.string().min(1),
    role: z.enum(['owner', 'admin', 'member']),
    // Optional for older events. The server acceptance command always sets it.
    invitationId: z.string().min(1).optional(),
  })
  .strict();

export type MemberJoinedData = z.infer<typeof memberJoinedDataSchema>;

// message.posted — someone (or a routine) posted a message into a
// conversation. The body is never stored in plain text in the event log
// (see events.md rule 5), so this carries the encrypted ciphertext plus
// the id of the key that encrypted it — the same pair agent.message_
// completed carries for the assistant's own messages — not the message
// itself.
export const messagePostedDataSchema = z
  .object({
    conversationId: z.string().min(1),
    authorId: z.string().min(1),
    authorKind: z.enum(['human', 'agent', 'system']),
    ciphertext: ciphertextSchema,
    keyId: keyIdSchema,
    contentType: z.enum(['text', 'markdown']),
    executionMode: z.literal('memory_free').optional(),
  })
  .strict();

export type MessagePostedData = z.infer<typeof messagePostedDataSchema>;

// approval.decided — a person decided a pending "Ask" tool call.
export const approvalDecidedDataSchema = z
  .object({
    approvalId: z.string().min(1),
    decision: z.enum(['approved', 'rejected']),
    decidedBy: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict();

export type ApprovalDecidedData = z.infer<typeof approvalDecidedDataSchema>;

// effect.observed — the gateway saw a real outbound call complete, and
// this is trusted evidence (as opposed to a computer's own self-report).
export const effectObservedDataSchema = z
  .object({
    permitId: z.string().min(1),
    computerId: z.string().min(1),
    // The tool that was called, e.g. "odoo.read" or a model name.
    tool: z.string().min(1),
    // What the call reached: a model, an MCP server, or a web domain.
    destination: z.string().min(1),
    // Integer euro cents, like budget.reserved and budget.settled: this is the
    // event the budget actor turns into budget.settled (settledCents), so it
    // has to be the same whole-cents shape, not a float in euros.
    costCents: centsSchema,
    outcome: z.enum(['success', 'error']),
    usage: z.object({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(),
      cachedInputTokens: z.int().nonnegative().optional(), cacheWriteTokens: z.int().nonnegative().optional(), priceTableId: z.string().min(1) }).strict().optional(),
  })
  .strict();

export type EffectObservedData = z.infer<typeof effectObservedDataSchema>;
