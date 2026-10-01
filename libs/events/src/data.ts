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
//   `ciphertext` (base64, a real minimum length) plus `keyId` (an opaque
//   "key:<id>" reference), or are not stored as events at all (streamed
//   deltas). See `encryptedText` below. A plain sentence, which is what an
//   accidental plaintext leak would actually look like, contains spaces
//   and punctuation that are not valid base64, so it cannot pass as
//   ciphertext, and a short word cannot pass either because it is shorter
//   than real encrypted output.
// - tool arguments are never stored raw, only as a digest (a sha-256 hex
//   string). See `digestSchema` below. The same applies to credentials:
//   they travel only as a `secretRef` (an opaque "secret:<id>" reference),
//   never a token or password value.
import { z } from 'zod';
import { SUBJECT_ID_PATTERN } from './subject.ts';

// A sha-256 hex digest: 64 lower-case hex characters. Using a shape this
// specific, rather than a plain string, means a raw argument list or a
// real secret value almost never accidentally validates as a "digest".
const HEX64 = /^[0-9a-f]{64}$/;
const digestSchema = z.string().regex(HEX64, 'expected a sha-256 hex digest, not the raw value');

// Shared field shapes, reused across schemas that need the same thing.
const id = z.string().min(1);
const minorUnits = z.int().nonnegative(); // EUR minor units (cents): 150 = €1.50
const roleSchema = z.enum(['owner', 'admin', 'member']);

// A short machine code such as "model_error" or "ssrf_guard_failed": lower
// case words joined by underscores. Used wherever an event needs a reason.
// A code has no spaces, so a sentence (which could carry conversation
// content or a person's name) cannot be put in a reason field.
export const reasonCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'reason must be a short snake_case code such as "model_error", not free text');

// An id that is used to build a stream's subject (see subject.ts): every
// event type whose `subjectFields` names a field uses this narrower shape
// for it, not the generic `id` above. Free-text fields that never feed a
// subject (a display name, a file path, a cron schedule) keep using `id`.
export const subjectId = z
  .string()
  .regex(SUBJECT_ID_PATTERN, 'must contain only letters, digits and underscores (subjects join ids with "-")');

// Encrypted text is standard base64 (RFC 4648, with "=" padding), never
// plaintext. The server uses one encoding, so base64url ("-" and "_") is
// not accepted: that also rules out a plaintext phrase glued together with
// hyphens or underscores, which would otherwise look like base64url. A real
// sentence like "wire EUR 10,000 today" fails outright (spaces, commas),
// and the minimum length rules out a short plaintext word.
//
// This is a shape check, not proof of encryption: one long plain word whose
// length is a multiple of 4 would still pass. It catches accidents (a
// sentence, JSON or a phrase put in the wrong field), not someone who
// deliberately disguises text. The real protection is that only the server
// encrypts and writes these events.
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const ciphertextSchema = z
  .string()
  .min(16, 'ciphertext must be real encrypted output (base64), not a placeholder or plaintext value')
  .regex(BASE64_PATTERN, 'ciphertext must be standard base64 with correct padding and no whitespace');

// A reference to the key that encrypted some ciphertext, or to a secret
// held in the secret store — never the key or secret value itself. The
// fixed prefix keeps a raw token or password from validating by accident:
// a real OAuth token or a real password practically never happens to
// start with "key:" or "secret:".
export const keyIdSchema = z
  .string()
  .regex(/^key:[A-Za-z0-9_-]+$/, 'keyId must be an opaque reference, e.g. "key:<id>", never the key itself');
export const secretRefSchema = z
  .string()
  .regex(
    /^secret:[A-Za-z0-9_-]+$/,
    'secretRef must be an opaque reference, e.g. "secret:<id>", never the credential value itself',
  );

// A URL's userinfo segment, e.g. the "admin:hunter2" in
// "https://admin:hunter2@example.com": scheme, then "//", then anything up
// to the next "/", "?" or "#" that itself ends in "@". Matching this with a
// plain regex (rather than the `URL` class) keeps this file free of a
// Node/DOM lib dependency for one narrow check.
const URL_USERINFO_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

// A query parameter name that usually carries a credential, checked
// case-insensitively against an MCP server locator below.
const SECRET_LOOKING_QUERY_PARAMS = ['api_key', 'apikey', 'token', 'access_token', 'key', 'secret', 'password'];
const SECRET_LOOKING_QUERY_PATTERN = new RegExp(`[?&](${SECRET_LOOKING_QUERY_PARAMS.join('|')})=`, 'i');

// mcp.server_registered.locator is a URL, never a credential holder: no
// `user:password@` in the authority, and no query parameter that looks
// like it is carrying a secret (the credential belongs in the secret
// store, referenced later by a connection's secretRef, not in the
// catalogue event).
export const locatorSchema = z
  .url()
  .refine(
    (value) => !URL_USERINFO_PATTERN.test(value),
    'locator must not carry credentials (no "user:password@" in the URL)',
  )
  .refine(
    (value) => !SECRET_LOOKING_QUERY_PATTERN.test(value),
    'locator must not carry a secret-looking query parameter (api_key, token, secret, ...)',
  );

// The encrypted-text pair: reused wherever conversation or memory text
// would otherwise appear, per events.md rule 5.
const encryptedText = { ciphertext: ciphertextSchema, keyId: keyIdSchema };

// --- Organisation, members and teams ---------------------------------

export const orgCreatedDataSchema = z.object({ orgName: id }).strict();

export const memberInvitedDataSchema = z
  .object({
    memberId: subjectId, // pre-allocated so later member.* events share one subject
    email: z.email(),
    role: roleSchema,
    invitedBy: id,
    invitationId: id,
  })
  .strict();

export const memberRoleChangedDataSchema = z
  .object({ memberId: subjectId, previousRole: roleSchema, newRole: roleSchema, changedBy: id })
  .strict();

export const memberRemovedDataSchema = z
  .object({ memberId: subjectId, removedBy: id, reason: reasonCodeSchema.optional() })
  .strict();

export const teamCreatedDataSchema = z.object({ teamId: subjectId, name: id, createdBy: id }).strict();

export const teamMemberAddedDataSchema = z
  .object({ teamId: subjectId, memberId: id, addedBy: id })
  .strict();

export const teamMemberRemovedDataSchema = z
  .object({ teamId: subjectId, memberId: id, removedBy: id })
  .strict();

// --- Assistants and computers -----------------------------------------
// The "computer" stream is keyed by the assistant it belongs to (the
// Streams table: `computer-<assistant>`), because a computer's identity
// persists across Pod replacements; `computerId` below names the current
// Pod/claim, but the stream subject is always the assistant's id.

export const assistantCreatedDataSchema = z
  .object({ assistantId: subjectId, ownerId: id, kind: z.enum(['personal', 'team']) })
  .strict();

export const assistantSettingsChangedDataSchema = z
  .object({
    assistantId: subjectId,
    changedBy: id,
    changedFields: z.array(z.enum(['model', 'persona', 'tools'])).min(1),
  })
  .strict();

export const computerClaimedDataSchema = z
  .object({ assistantId: subjectId, computerId: id, podUid: id, generation: z.int().nonnegative() })
  .strict();

export const computerReadyDataSchema = z.object({ assistantId: subjectId, computerId: id }).strict();

export const computerSuspendedDataSchema = z
  .object({ assistantId: subjectId, computerId: id, snapshotId: id.optional() })
  .strict();

export const computerResumedDataSchema = z
  .object({ assistantId: subjectId, computerId: id, snapshotId: id.optional() })
  .strict();

export const computerLostDataSchema = z.object({ assistantId: subjectId, computerId: id }).strict();

export const computerRetiredDataSchema = z.object({ assistantId: subjectId, computerId: id }).strict();

export const takeoverStartedDataSchema = z
  .object({ assistantId: subjectId, computerId: id, requestedBy: id })
  .strict();

export const takeoverEndedDataSchema = z
  .object({ assistantId: subjectId, computerId: id, endedBy: id })
  .strict();

// --- Conversations and agent activity ----------------------------------

export const conversationCreatedDataSchema = z
  .object({ conversationId: subjectId, assistantId: id, createdBy: id })
  .strict();

export const participantAddedDataSchema = z
  .object({ conversationId: subjectId, participantId: id, addedBy: id })
  .strict();

export const participantRemovedDataSchema = z
  .object({ conversationId: subjectId, participantId: id, removedBy: id })
  .strict();

export const agentTurnStartedDataSchema = z
  .object({ conversationId: subjectId, turnId: id, assistantId: id })
  .strict();

export const agentTurnCompletedDataSchema = z.object({ conversationId: subjectId, turnId: id }).strict();

export const agentTurnFailedDataSchema = z
  .object({ conversationId: subjectId, turnId: id, reason: reasonCodeSchema })
  .strict();

// Risky type: the bridge reports a completed assistant message, but the
// text itself never travels in the event — only a reference to its
// ciphertext, exactly like message.posted.
export const agentMessageCompletedDataSchema = z
  .object({
    conversationId: subjectId,
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
  .object({ conversationId: subjectId, turnId: id, ...encryptedText })
  .strict();

// Risky type: a command's arguments are never stored raw, only as a
// digest (events.md: "tool arguments only as a digest").
export const agentCommandRanDataSchema = z
  .object({
    conversationId: subjectId,
    turnId: id,
    commandDigest: digestSchema,
    exitCode: z.int().min(0).max(255),
  })
  .strict();

export const agentFileChangedDataSchema = z
  .object({
    conversationId: subjectId,
    turnId: id,
    path: id,
    changeType: z.enum(['created', 'modified', 'deleted']),
  })
  .strict();

export const conversationClosedDataSchema = z
  .object({ conversationId: subjectId, closedBy: id })
  .strict();

// --- Tools, approvals and effects ---------------------------------------

// Risky type: the call's own arguments are never carried, only a digest,
// so the approval card is built from the tool name and this digest.
export const toolApprovalRequestedDataSchema = z
  .object({
    approvalId: subjectId,
    conversationId: id,
    turnId: id,
    assistantId: id, // approvals are bound to requester, conversation, turn, assistant and digest
    tool: id,
    argumentsDigest: digestSchema,
    requesterId: id,
  })
  .strict();

export const approvalExpiredDataSchema = z.object({ approvalId: subjectId }).strict();

export const approvalUsedDataSchema = z.object({ approvalId: subjectId, permitId: id }).strict();

export const effectUncertainDataSchema = z
  .object({ permitId: subjectId, computerId: id, reason: z.enum(['settle_timeout', 'computer_lost']) })
  .strict();

export const effectResolvedDataSchema = z
  .object({ permitId: subjectId, resolvedBy: id, outcome: z.enum(['settled', 'released']) })
  .strict();

// --- MCP catalogue, grants and connections ------------------------------

export const mcpServerRegisteredDataSchema = z
  .object({ serverId: subjectId, kind: z.enum(['remote', 'hosted']), locator: locatorSchema, registeredBy: id })
  .strict();

export const mcpServerDiscoveredDataSchema = z
  .object({ serverId: subjectId, toolCount: z.int().nonnegative(), schemaDigest: digestSchema })
  .strict();

export const mcpServerRejectedDataSchema = z
  .object({ serverId: subjectId, reason: reasonCodeSchema })
  .strict();

export const mcpToolModeSetDataSchema = z
  .object({ serverId: subjectId, toolName: id, mode: z.enum(['allow', 'ask', 'block']), setBy: id })
  .strict();

export const mcpServerPublishedDataSchema = z
  .object({ serverId: subjectId, publishedBy: id })
  .strict();

export const mcpServerUnpublishedDataSchema = z
  .object({ serverId: subjectId, unpublishedBy: id })
  .strict();

export const mcpToolListChangedDataSchema = z
  .object({ serverId: subjectId, previousSchemaDigest: digestSchema, newSchemaDigest: digestSchema })
  .strict();

export const grantGivenDataSchema = z
  .object({
    resourceType: subjectId,
    resourceId: subjectId,
    granteeId: id,
    granteeKind: z.enum(['member', 'team', 'assistant']),
    grantedBy: id,
  })
  .strict();

export const grantRevokedDataSchema = z
  .object({ resourceType: subjectId, resourceId: subjectId, granteeId: id, revokedBy: id })
  .strict();

// Risky type: the secret itself never appears here, only a reference id
// the secret store understands. userId, serverId and profile together
// build this stream's composite subject (connection-<user>-<server>-
// <profile>), so all three use the subject-safe id shape, not just one.
export const connectionCreatedDataSchema = z
  .object({ userId: subjectId, serverId: subjectId, profile: subjectId, secretRef: secretRefSchema })
  .strict();

export const connectionRefreshedDataSchema = z
  .object({ userId: subjectId, serverId: subjectId, profile: subjectId, secretRef: secretRefSchema })
  .strict();

export const connectionRevokedDataSchema = z
  .object({ userId: subjectId, serverId: subjectId, profile: subjectId, revokedBy: id })
  .strict();

// --- Budgets (single-writer actor per silo) -----------------------------

// A ceiling or exhaustion applies to one scope: the whole silo ("global",
// no scopeId), one paying group, or one assistant (those two must name
// which one). Three strict shapes keyed on `scope` make "assistant with no
// scopeId" and "global with a scopeId" invalid instead of silently legal.
const ceilingFields = { ceilingMinorUnits: minorUnits, setBy: id };
export const budgetCeilingSetDataSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global'), ...ceilingFields }).strict(),
  z.object({ scope: z.literal('paying_group'), scopeId: id, ...ceilingFields }).strict(),
  z.object({ scope: z.literal('assistant'), scopeId: id, ...ceilingFields }).strict(),
]);

// The reservation names both the paying group and the assistant, because
// the budget actor checks every ceiling (global, group, optional
// per-assistant) in the one append that records the charge.
export const budgetReservedDataSchema = z
  .object({ reservationId: id, permitId: id, amountMinorUnits: minorUnits, payingGroupId: id, assistantId: id })
  .strict();

export const budgetSettledDataSchema = z
  .object({ reservationId: id, permitId: id, settledMinorUnits: minorUnits })
  .strict();

export const budgetPeriodStartedDataSchema = z
  .object({ periodStart: z.iso.datetime({ offset: true }) })
  .strict();

export const budgetExhaustedDataSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }).strict(),
  z.object({ scope: z.literal('paying_group'), scopeId: id }).strict(),
  z.object({ scope: z.literal('assistant'), scopeId: id }).strict(),
]);

// --- Company brain -------------------------------------------------------

// Risky type: a memory's own text is never carried in the event, only its
// ciphertext and the key that encrypted it (so "forget" only has to
// delete the key).
export const memoryWrittenDataSchema = z
  .object({ scopeId: subjectId, memoryId: id, ...encryptedText })
  .strict();

export const memoryCorrectedDataSchema = z
  .object({ scopeId: subjectId, memoryId: id, ...encryptedText })
  .strict();

export const memoryForgottenDataSchema = z.object({ scopeId: subjectId, memoryId: id }).strict();

export const memoryConsolidatedDataSchema = z
  .object({ scopeId: subjectId, consolidationId: id, memoryIds: z.array(id).min(1) })
  .strict();

export const scopePromotionRequestedDataSchema = z
  .object({ scopeId: subjectId, targetScopeId: id, requestedBy: id })
  .strict();

export const scopePromotedDataSchema = z
  .object({ scopeId: subjectId, targetScopeId: id, approvedBy: id })
  .strict();

// --- Routines and delegation ----------------------------------------------

export const routineCreatedDataSchema = z
  .object({ routineId: subjectId, assistantId: id, schedule: id, createdBy: id })
  .strict();

export const routineUpdatedDataSchema = z
  .object({ routineId: subjectId, schedule: id, updatedBy: id })
  .strict();

export const routinePausedDataSchema = z.object({ routineId: subjectId, pausedBy: id }).strict();

export const routineResumedDataSchema = z.object({ routineId: subjectId, resumedBy: id }).strict();

export const routineRetiredDataSchema = z.object({ routineId: subjectId, retiredBy: id }).strict();

export const routineDueDataSchema = z
  .object({ routineId: subjectId, firedAt: z.iso.datetime({ offset: true }) })
  .strict();

export const delegationStartedDataSchema = z
  .object({ delegationId: subjectId, parentComputerId: id, childComputerId: id, rootBudgetId: id })
  .strict();

export const delegationCompletedDataSchema = z
  .object({ delegationId: subjectId, outcome: z.enum(['success', 'failure']) })
  .strict();

// --- Security --------------------------------------------------------------

export const securityAlertRaisedDataSchema = z
  .object({
    alertId: id,
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    reason: reasonCodeSchema,
  })
  .strict();
