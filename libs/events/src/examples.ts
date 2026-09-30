// Fully-typed `data` schemas for the four example events the Phase 1 task
// asked for. Every other event type in the registry now has its own real,
// strict schema too (see data.ts and registry.ts) — these four are kept
// here, separate, as the task's own worked examples, and reuse the same
// shared field shapes (subjectId, ciphertext, keyId) from data.ts so they
// follow the same rules as everything else.
import { z } from 'zod';
import { ciphertextSchema, keyIdSchema, subjectId } from './data.ts';

// member.joined — an invitation was accepted and someone became a member.
// docs/architecture/events.md: "OpenFGA `member`; emit `assistant.created`".
export const memberJoinedDataSchema = z
  .object({
    memberId: subjectId,
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
// (see events.md rule 5), so this carries the encrypted ciphertext plus
// the id of the key that encrypted it — the same pair agent.message_
// completed carries for the assistant's own messages — not the message
// itself.
export const messagePostedDataSchema = z
  .object({
    conversationId: subjectId,
    authorId: z.string().min(1),
    authorKind: z.enum(['human', 'agent', 'system']),
    ciphertext: ciphertextSchema,
    keyId: keyIdSchema,
    contentType: z.enum(['text', 'markdown']),
  })
  .strict();

export type MessagePostedData = z.infer<typeof messagePostedDataSchema>;

// approval.decided — a person decided a pending "Ask" tool call.
export const approvalDecidedDataSchema = z
  .object({
    approvalId: subjectId,
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
    permitId: subjectId,
    computerId: z.string().min(1),
    // The tool that was called, e.g. "odoo.read" or a model name.
    tool: z.string().min(1),
    // What the call reached: a model, an MCP server, or a web domain.
    destination: z.string().min(1),
    // EUR minor units (cents), matching budget.reserved/.settled: this is
    // the event the budget actor turns into budget.settled.
    // settledMinorUnits, so it has to be the same integer-cents shape, not
    // a float that can't add up exactly (0.1 + 0.2 !== 0.3 in float EUR).
    costMinorUnits: z.int().nonnegative(),
    outcome: z.enum(['success', 'error']),
  })
  .strict();

export type EffectObservedData = z.infer<typeof effectObservedDataSchema>;
