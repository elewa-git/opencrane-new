// Data schemas for every event type in the registry except the four
// examples in examples.ts. Each one is built from what
// docs/architecture/events.md and plan.md say the event means: which ids
// it needs, who did it, and what a projection or reaction listed in the
// catalogue actually reads off it. Every schema is `.strict()`, so an
// extra field is rejected the same way a wrong field is.
//
// Two security rules from events.md rule 5 and plan.md are schema rules
// here, not just prose:
// - message and agent text never travel as plain text: they carry
//   `ciphertext` (base64) plus `keyId`, or are not stored as events at all
//   (streamed deltas). See `encryptedText` below.
// - tool arguments are never stored raw, only as a digest (a sha-256 hex
//   string). See `digestSchema` below. The same applies to credentials:
//   they travel only as a `secretRef` id, never a token or password value.
import { z } from 'zod';

// A sha-256 hex digest: 64 lower-case hex characters. Using a shape this
// specific, rather than a plain string, means a raw argument list or a
// real secret value almost never accidentally validates as a "digest".
const HEX64 = /^[0-9a-f]{64}$/;
const digestSchema = z.string().regex(HEX64, 'expected a sha-256 hex digest, not the raw value');

// Shared field shapes, reused across schemas that need the same thing.
const id = z.string().min(1);
const minorUnits = z.int().nonnegative(); // EUR minor units (cents): 150 = €1.50
const roleSchema = z.enum(['owner', 'admin', 'member']);
const budgetScopeSchema = z.enum(['global', 'paying_group', 'assistant']);
// The encrypted-text pair: reused wherever conversation or memory text
// would otherwise appear, per events.md rule 5.
const encryptedText = { ciphertext: id, keyId: id };

// --- Organisation, members and teams ---------------------------------

export const orgCreatedDataSchema = z.object({ orgName: id }).strict();

export const memberInvitedDataSchema = z
  .object({
    memberId: id, // pre-allocated so later member.* events share one subject
    email: z.email(),
    role: roleSchema,
    invitedBy: id,
    invitationId: id,
  })
  .strict();

export const memberRoleChangedDataSchema = z
  .object({ memberId: id, previousRole: roleSchema, newRole: roleSchema, changedBy: id })
  .strict();

export const memberRemovedDataSchema = z
  .object({ memberId: id, removedBy: id, reason: id.optional() })
  .strict();

export const teamCreatedDataSchema = z.object({ teamId: id, name: id, createdBy: id }).strict();

export const teamMemberAddedDataSchema = z
  .object({ teamId: id, memberId: id, addedBy: id })
  .strict();

export const teamMemberRemovedDataSchema = z
  .object({ teamId: id, memberId: id, removedBy: id })
  .strict();

// --- Assistants and computers -----------------------------------------
// The "computer" stream is keyed by the assistant it belongs to (the
// Streams table: `computer-<assistant>`), because a computer's identity
// persists across Pod replacements; `computerId` below names the current
// Pod/claim, but the stream subject is always the assistant's id.

export const assistantCreatedDataSchema = z
  .object({ assistantId: id, ownerId: id, kind: z.enum(['personal', 'team']) })
  .strict();

export const assistantSettingsChangedDataSchema = z
  .object({
    assistantId: id,
    changedBy: id,
    changedFields: z.array(z.enum(['model', 'persona', 'tools'])).min(1),
  })
  .strict();

export const computerClaimedDataSchema = z
  .object({ assistantId: id, computerId: id, podUid: id, generation: z.int().nonnegative() })
  .strict();

export const computerReadyDataSchema = z.object({ assistantId: id, computerId: id }).strict();

export const computerSuspendedDataSchema = z
  .object({ assistantId: id, computerId: id, snapshotId: id.optional() })
  .strict();

export const computerResumedDataSchema = z
  .object({ assistantId: id, computerId: id, snapshotId: id.optional() })
  .strict();

export const computerLostDataSchema = z.object({ assistantId: id, computerId: id }).strict();

export const computerRetiredDataSchema = z.object({ assistantId: id, computerId: id }).strict();

export const takeoverStartedDataSchema = z
  .object({ assistantId: id, computerId: id, requestedBy: id })
  .strict();

export const takeoverEndedDataSchema = z
  .object({ assistantId: id, computerId: id, endedBy: id })
  .strict();

// --- Conversations and agent activity ----------------------------------

export const conversationCreatedDataSchema = z
  .object({ conversationId: id, assistantId: id, createdBy: id })
  .strict();

export const participantAddedDataSchema = z
  .object({ conversationId: id, participantId: id, addedBy: id })
  .strict();

export const participantRemovedDataSchema = z
  .object({ conversationId: id, participantId: id, removedBy: id })
  .strict();

export const agentTurnStartedDataSchema = z
  .object({ conversationId: id, turnId: id, assistantId: id })
  .strict();

export const agentTurnCompletedDataSchema = z.object({ conversationId: id, turnId: id }).strict();

export const agentTurnFailedDataSchema = z
  .object({ conversationId: id, turnId: id, reason: id })
  .strict();

// Risky type: the bridge reports a completed assistant message, but the
// text itself never travels in the event — only a reference to its
// ciphertext, exactly like message.posted.
export const agentMessageCompletedDataSchema = z
  .object({
    conversationId: id,
    turnId: id,
    messageId: id,
    ...encryptedText,
    contentType: z.enum(['text', 'markdown']),
  })
  .strict();

// Reasoning summaries follow the same retention (and so the same
// encryption) rule as chat messages (plan.md, Conversation stream and
// audit).
export const agentReasoningSummarisedDataSchema = z
  .object({ conversationId: id, turnId: id, ...encryptedText })
  .strict();

// Risky type: a command's arguments are never stored raw, only as a
// digest (events.md: "tool arguments only as a digest").
export const agentCommandRanDataSchema = z
  .object({
    conversationId: id,
    turnId: id,
    commandDigest: digestSchema,
    exitCode: z.int().min(0).max(255),
  })
  .strict();

export const agentFileChangedDataSchema = z
  .object({
    conversationId: id,
    turnId: id,
    path: id,
    changeType: z.enum(['created', 'modified', 'deleted']),
  })
  .strict();

export const conversationClosedDataSchema = z
  .object({ conversationId: id, closedBy: id })
  .strict();

// --- Tools, approvals and effects ---------------------------------------

// Risky type: the call's own arguments are never carried, only a digest,
// so the approval card is built from the tool name and this digest.
export const toolApprovalRequestedDataSchema = z
  .object({
    approvalId: id,
    conversationId: id,
    turnId: id,
    tool: id,
    argumentsDigest: digestSchema,
    requesterId: id,
  })
  .strict();

export const approvalExpiredDataSchema = z.object({ approvalId: id }).strict();

export const approvalUsedDataSchema = z.object({ approvalId: id, permitId: id }).strict();

export const effectUncertainDataSchema = z
  .object({ permitId: id, computerId: id, reason: z.enum(['settle_timeout', 'computer_lost']) })
  .strict();

export const effectResolvedDataSchema = z
  .object({ permitId: id, resolvedBy: id, outcome: z.enum(['settled', 'released']) })
  .strict();

// --- MCP catalogue, grants and connections ------------------------------

export const mcpServerRegisteredDataSchema = z
  .object({ serverId: id, kind: z.enum(['remote', 'hosted']), locator: id, registeredBy: id })
  .strict();

export const mcpServerDiscoveredDataSchema = z
  .object({ serverId: id, toolCount: z.int().nonnegative(), schemaDigest: digestSchema })
  .strict();

export const mcpServerRejectedDataSchema = z.object({ serverId: id, reason: id }).strict();

export const mcpToolModeSetDataSchema = z
  .object({ serverId: id, toolName: id, mode: z.enum(['allow', 'ask', 'block']), setBy: id })
  .strict();

export const mcpServerPublishedDataSchema = z
  .object({ serverId: id, publishedBy: id })
  .strict();

export const mcpServerUnpublishedDataSchema = z
  .object({ serverId: id, unpublishedBy: id })
  .strict();

export const mcpToolListChangedDataSchema = z
  .object({ serverId: id, previousSchemaDigest: digestSchema, newSchemaDigest: digestSchema })
  .strict();

export const grantGivenDataSchema = z
  .object({
    resourceId: id,
    resourceType: id,
    granteeId: id,
    granteeKind: z.enum(['member', 'team', 'assistant']),
    grantedBy: id,
  })
  .strict();

export const grantRevokedDataSchema = z
  .object({ resourceId: id, granteeId: id, revokedBy: id })
  .strict();

// Risky type: the secret itself never appears here, only a reference id
// the secret store understands.
export const connectionCreatedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, secretRef: id })
  .strict();

export const connectionRefreshedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, secretRef: id })
  .strict();

export const connectionRevokedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, revokedBy: id })
  .strict();

// --- Budgets (single-writer actor per silo) -----------------------------

export const budgetCeilingSetDataSchema = z
  .object({
    scope: budgetScopeSchema,
    scopeId: id.optional(), // set for paying_group and assistant, omitted for global
    ceilingMinorUnits: minorUnits,
    setBy: id,
  })
  .strict();

export const budgetReservedDataSchema = z
  .object({ reservationId: id, permitId: id, amountMinorUnits: minorUnits, payingGroupId: id })
  .strict();

export const budgetSettledDataSchema = z
  .object({ reservationId: id, permitId: id, settledMinorUnits: minorUnits })
  .strict();

export const budgetPeriodStartedDataSchema = z
  .object({ periodStart: z.iso.datetime({ offset: true }) })
  .strict();

export const budgetExhaustedDataSchema = z
  .object({ scope: budgetScopeSchema, scopeId: id.optional() })
  .strict();

// --- Company brain -------------------------------------------------------

// Risky type: a memory's own text is never carried in the event, only its
// ciphertext and the key that encrypted it (so "forget" only has to
// delete the key).
export const memoryWrittenDataSchema = z
  .object({ scopeId: id, memoryId: id, ...encryptedText })
  .strict();

export const memoryCorrectedDataSchema = z
  .object({ scopeId: id, memoryId: id, ...encryptedText })
  .strict();

export const memoryForgottenDataSchema = z.object({ scopeId: id, memoryId: id }).strict();

export const memoryConsolidatedDataSchema = z
  .object({ scopeId: id, consolidationId: id, memoryIds: z.array(id).min(1) })
  .strict();

export const scopePromotionRequestedDataSchema = z
  .object({ scopeId: id, targetScopeId: id, requestedBy: id })
  .strict();

export const scopePromotedDataSchema = z
  .object({ scopeId: id, targetScopeId: id, approvedBy: id })
  .strict();

// --- Routines and delegation ----------------------------------------------

export const routineCreatedDataSchema = z
  .object({ routineId: id, assistantId: id, schedule: id, createdBy: id })
  .strict();

export const routineUpdatedDataSchema = z
  .object({ routineId: id, schedule: id, updatedBy: id })
  .strict();

export const routinePausedDataSchema = z.object({ routineId: id, pausedBy: id }).strict();

export const routineResumedDataSchema = z.object({ routineId: id, resumedBy: id }).strict();

export const routineRetiredDataSchema = z.object({ routineId: id, retiredBy: id }).strict();

export const routineDueDataSchema = z
  .object({ routineId: id, firedAt: z.iso.datetime({ offset: true }) })
  .strict();

export const delegationStartedDataSchema = z
  .object({ delegationId: id, parentComputerId: id, childComputerId: id, rootBudgetId: id })
  .strict();

export const delegationCompletedDataSchema = z
  .object({ delegationId: id, outcome: z.enum(['success', 'failure']) })
  .strict();

// --- Security --------------------------------------------------------------

export const securityAlertRaisedDataSchema = z
  .object({
    alertId: id,
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    reason: id,
  })
  .strict();
