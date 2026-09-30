// Fully-typed `data` schemas for the four example events the Phase 1 task
// asks for. Every other event in the registry uses a `z.unknown()`
// placeholder until the slice that owns it gives it a real schema.
import { z } from 'zod';

// member.joined — an invitation was accepted and someone became a member.
// docs/architecture/events.md: "OpenFGA `member`; emit `assistant.created`".
export const memberJoinedDataSchema = z
  .object({
    memberId: z.string().min(1),
    email: z.email(),
    displayName: z.string().min(1),
    role: z.enum(['owner', 'admin', 'member']),
    // The invitation this join came from, if any (a person can also join
    // through single sign-on with no standing invitation).
    invitationId: z.string().min(1).optional(),
  })
  .strict();

export type MemberJoinedData = z.infer<typeof memberJoinedDataSchema>;

// message.posted — someone (or a routine) posted a message into a
// conversation. The body is never stored in plain text in the event log
// (see events.md rule 5), so this carries a reference to the encrypted
// ciphertext, not the message itself.
export const messagePostedDataSchema = z
  .object({
    conversationId: z.string().min(1),
    authorId: z.string().min(1),
    authorKind: z.enum(['human', 'agent', 'system']),
    // Base64 ciphertext, encrypted with the conversation's key.
    ciphertext: z.string().min(1),
    contentType: z.enum(['text', 'markdown']),
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
    costEur: z.number().nonnegative(),
    outcome: z.enum(['success', 'error']),
  })
  .strict();

export type EffectObservedData = z.infer<typeof effectObservedDataSchema>;
