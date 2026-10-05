// Data schemas for every event type in the registry except the four
// examples in examples.ts. Each is built from what docs/architecture/events.md
// and plan.md say the event means: which ids it needs, who did it, and what a
// projection or reaction in the catalogue reads off it. Every schema is
// `.strict()`, so an extra field is rejected like a wrong one.
//
// Two security rules from events.md rule 5 are schema rules here, not prose:
// - message and agent text travel only as `ciphertext` plus `keyId` (see
//   `ciphertextSchema`), including streamed deltas;
// - tool arguments and commands travel only as a sha-256 digest, and
//   credentials only as a `secretRef`, never a token or password value.
import { z } from 'zod';

// A sha-256 hex digest: 64 lower-case hex characters. Using a shape this
// specific, rather than a plain string, means a raw argument list or a
// real secret value almost never accidentally validates as a "digest".
const HEX64 = /^[0-9a-f]{64}$/;
const digestSchema = z.string().regex(HEX64, 'expected a sha-256 hex digest, not the raw value');

// Shared field shapes, reused across schemas that need the same thing.
const id = z.string().min(1);
const tokenId = z.string().regex(/^token:[A-Za-z0-9_-]+$/, 'tokenId must be a reference, never a token value');
const roleSchema = z.enum(['owner', 'admin', 'member']);

// Money is integer euro cents everywhere (owner decision 8): 150 = €1.50. Every
// amount in an event is a whole, non-negative number of cents and its name ends
// in `Cents`, never a float in euros (0.1 + 0.2 !== 0.3), so sums stay exact.
// `z.int()` also refuses anything beyond the safe integer range.
export const centsSchema = z.int().nonnegative();

// A short machine code such as "model_error" or "ssrf_guard_failed": lower
// case words joined by underscores. Used wherever an event needs a reason.
// A code has no spaces, so a sentence (which could carry conversation
// content or a person's name) cannot be put in a reason field.
const reasonCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'reason must be a short snake_case code such as "model_error", not free text');

// Encrypted text is standard base64 (RFC 4648, "=" padded), never plaintext.
// A sentence fails outright (spaces, commas), base64url is refused so a
// hyphenated or underscored phrase cannot pass, and the minimum length refuses
// a short word. This is a shape check, not proof of encryption: one long plain
// word whose length is a multiple of 4 would pass. It catches accidents, not
// disguise; the real protection is that only the server encrypts and writes
// these events.
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const ciphertextSchema = z
  .string()
  .min(16, 'ciphertext must be real encrypted output (base64), not a placeholder or plaintext value')
  .regex(BASE64_PATTERN, 'ciphertext must be standard base64 with correct padding and no whitespace');

// A reference to the key that encrypted some ciphertext, or to a secret in the
// secret store, never the key or secret itself. The fixed prefix stops a raw
// token or password from validating by accident.
export const keyIdSchema = z
  .string()
  .regex(/^key:[A-Za-z0-9_-]+$/, 'keyId must be an opaque reference, e.g. "key:<id>", never the key itself');
const secretRefSchema = z
  .string()
  .regex(
    /^secret:[A-Za-z0-9_-]+$/,
    'secretRef must be an opaque reference, e.g. "secret:<id>", never the credential value itself',
  );

// An MCP server is registered as a URL or as an image (plan.md, "Installing
// an MCP server"), and `locator` means something different for each, so the
// two are separate shapes keyed on `kind`. Neither may hold a accountMode: that
// goes in the secret store, referenced later by a connection's `secretRef`.
//
// A remote locator is a plain http(s) URL: a scheme other than http or https
// (`file:`, `javascript:`) is out; no username or password, checked on the
// URL as the standard parser reads it (which also accepts spellings such as
// "https:///admin:pass@host"); and no query string or fragment at all, since
// a secret hides in an innocent-looking name ("?api%5Fkey=", "#access_token=")
// and the server's address is the path. Whitespace, control characters and
// backslashes are out too: parsers read them differently or quietly strip
// them. That text check runs first, on the input as it arrived, because
// `z.url()` trims it and strips tabs and newlines from the value it passes on.
//
// `URL` exists in Node and every browser, but this shared library loads
// neither type library, so only the part used here is declared.
declare const URL: {
  canParse(input: string): boolean;
  new (input: string): { readonly username: string; readonly password: string };
};
const PLAIN_URL_TEXT_PATTERN = /^[^\s\\?#\p{Cc}]+$/u;
const remoteLocatorSchema = z
  .string()
  .regex(PLAIN_URL_TEXT_PATTERN, 'locator must be a plain URL: no query string, no fragment, no whitespace')
  .pipe(
    z
      .url({ protocol: /^https?$/, error: 'locator must be an http or https URL' })
      .refine((value) => {
        // A refinement still runs after a bad URL, and `new URL` throws on one.
        if (!URL.canParse(value)) {
          return false;
        }
        const parsed = new URL(value);
        return parsed.username === '' && parsed.password === '';
      }, 'locator must not carry credentials (no "user:password@" in the URL)'),
  );

// A hosted locator is an image pinned by digest, "<registry>/<repository>@
// sha256:<64 hex>". A tag such as ":latest" can be moved to other code after
// the image was scanned and signed; a digest cannot. The registry is always
// named (a host with a dot, or localhost, and an optional port), so nothing
// depends on a default registry. Lower case only, as repositories are.
const IMAGE_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE_REGISTRY = '(?:localhost|(?:[a-z0-9-]+\\.)+[a-z0-9-]+)(?::[0-9]{1,5})?';
const HOSTED_IMAGE_PATTERN = new RegExp(`^${IMAGE_REGISTRY}(?:/${IMAGE_COMPONENT})+@sha256:[0-9a-f]{64}$`);
const hostedLocatorSchema = z
  .string()
  .regex(HOSTED_IMAGE_PATTERN, 'locator must be an image pinned by digest, "<registry>/<repository>@sha256:<hex>"');

// The encrypted-text pair: reused wherever conversation or memory text
// would otherwise appear, per events.md rule 5.
const encryptedText = { ciphertext: ciphertextSchema, keyId: keyIdSchema };

// --- Organisation, members and teams ---------------------------------

export const orgCreatedDataSchema = z.object({ orgName: id }).strict();

export const memberInvitedDataSchema = z
  .object({
    memberId: id, // pre-allocated so later member.* events share one subject
    email: z.email(),
    role: roleSchema,
    invitedBy: id,
    invitationId: id,
    // Older invitations replay, but cannot be accepted without both fields.
    invitedIdentity: z.object({ issuer: z.url(), sub: id }).strict().optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const memberRoleChangedDataSchema = z
  .object({ memberId: id, previousRole: roleSchema, newRole: roleSchema, changedBy: id })
  .strict();

export const memberRemovedDataSchema = z
  .object({ memberId: id, removedBy: id, reason: reasonCodeSchema.optional() })
  .strict();

function hasNoNul(value: string) {
  return !value.includes('\0');
}
export const teamCreatedDataSchema = z.object({
  teamId: id, name: id.refine(hasNoNul), createdBy: id,
  membershipSource: z.enum(['local', 'identity_provider']).optional(),
}).strict();

export const teamMemberAddedDataSchema = z
  .object({ teamId: id, memberId: id, addedBy: id, membershipSource: z.enum(['local', 'identity_provider']).optional() })
  .strict();

export const teamMemberRemovedDataSchema = z
  .object({ teamId: id, memberId: id, removedBy: id })
  .strict();

// --- Assistants and computers -----------------------------------------
// The "computer" stream is keyed by the assistant it belongs to (the
// Streams table: `computer-<assistant>`), because a computer's identity
// persists across Pod replacements; `computerId` below names the current
// Pod/claim, but the stream subject is always the assistant's id.

export const assistantGrantSchema = z.discriminatedUnion('resourceType', [
  z.object({ resourceType: z.literal('model'),
    resourceId: z.string().regex(/^[\w.-]{1,200}$/u) }).strict(),
  z.object({ resourceType: z.literal('mcp_server'),
    resourceId: z.string().regex(/^[\w-]{1,200}$/u) }).strict(),
]);
export const assistantCreatedDataSchema = z.object({
  assistantId: id, ownerId: id, kind: z.enum(['personal', 'team']),
  payingGroupId: id.optional(),
  name: z.string().trim().min(1).max(200).refine(hasNoNul).optional(),
  grants: z.array(assistantGrantSchema).min(1).max(32).optional(),
}).strict();

export const assistantSettingsChangedDataSchema = z
  .object({
    assistantId: id,
    changedBy: id,
    active: z.boolean().optional(),
    changedFields: z.array(z.enum(['model', 'persona', 'tools', 'active'])).min(1),
  })
  .strict();

export const computerClaimedDataSchema = z
  .object({ assistantId: id, computerId: id, sandboxUid: id.optional(), generation: z.int().positive(), tokenId })
  .strict();

export const computerReadyDataSchema = z.object({ assistantId: id, computerId: id, generation: z.int().positive().optional(), podUid: id.optional(), sandboxUid: id.optional() }).strict();

export const computerSuspendedDataSchema = z
  .object({ assistantId: id, computerId: id, snapshotId: id.optional() })
  .strict();

export const computerResumedDataSchema = z
  .object({ assistantId: id, computerId: id, tokenId, generation: z.int().positive().optional(), snapshotId: id.optional() })
  .strict();

export const computerLostDataSchema = z.object({ assistantId: id, computerId: id }).strict();

export const computerRetiredDataSchema = z.object({ assistantId: id, computerId: id }).strict();

export const takeoverStartedDataSchema = z
  .object({ assistantId: id, computerId: id, requestedBy: id })
  .strict();

export const takeoverEndedDataSchema = z
  .object({ assistantId: id, computerId: id, endedBy: id })
  .strict();

// A computer profile is one computer image plus the Codex built-in tool
// settings that go with it (owner decision 9). Publishing a profile whose tools
// differ is `toolset.changed`; it is about the computer's own tools, not about a
// registered MCP server (that is mcp.tools_changed). It goes on the profile's own
// stream, `toolset-<profile>`, not on a computer's stream: one admin command
// changes every computer that uses the profile, and a command appends to one
// stream only. The event holds the whole profile as it now stands, not a
// difference, so replay rebuilds the `toolsets` projection from events alone.
// Nothing free-form travels in it: the image is named by its digest, the
// programs and runtimes inside it (CLI programs, local stdio MCP such as
// Playwright) by one digest of their inventory, and each built-in tool by a
// fixed name.
const imageDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected an image digest such as "sha256:<64 hex>", not a tag');

// A plain version number such as "0.46.0", with an optional pre-release part.
const codexVersionSchema = z
  .string()
  .max(64)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/, 'expected a version such as "0.46.0"');

// The Codex built-in tools an admin can switch on or off. A tool not named here
// is refused until someone has decided how the gateway treats it (a hosted tool
// such as web_search is allowed or stripped by the gateway on the model request).
const builtInToolSchema = z.enum(['shell', 'apply_patch', 'web_search', 'view_image', 'spawn_agent']);
const builtInToolSettingSchema = z.object({ tool: builtInToolSchema, enabled: z.boolean() }).strict();

export const toolsetChangedDataSchema = z
  .object({
    profileId: id,
    imageDigest: imageDigestSchema,
    codexVersion: codexVersionSchema,
    // One entry per tool at most, so the same tool cannot be both on and off.
    builtInTools: z
      .array(builtInToolSettingSchema)
      .min(1)
      .refine(
        (settings) => new Set(settings.map((setting) => setting.tool)).size === settings.length,
        'each built-in tool may be listed once',
      ),
    inventoryDigest: digestSchema,
    publishedBy: id,
  })
  .strict();

// --- Conversations and agent activity ----------------------------------

function hasDirectParticipants(data: { createdBy: string; participantIds: string[] }) {
  const [first, second] = data.participantIds;
  return first !== second && data.participantIds.includes(data.createdBy);
}

// Missing mode belongs only to legacy assistant sessions. New human records are explicit.
export const conversationCreatedDataSchema = z.union([
  z.object({
    conversationId: id, assistantId: id, createdBy: id,
    mode: z.literal('agent_session').default('agent_session'), payingGroupId: id.optional(),
  }).strict(),
  z.object({
    conversationId: id, createdBy: id, mode: z.literal('direct'),
    participantIds: z.array(id).length(2),
  }).strict().refine(hasDirectParticipants, 'Direct conversations require two distinct people'),
]);

export const participantAddedDataSchema = z
  .object({ conversationId: id, participantId: id, addedBy: id })
  .strict();

export const participantRemovedDataSchema = z
  .object({ conversationId: id, participantId: id, removedBy: id })
  .strict();

export const agentTurnStartedDataSchema = z
  .object({ conversationId: id, turnId: id, assistantId: id, threadId: id.optional() })
  .strict();

export const agentTurnCompletedDataSchema = z.object({ conversationId: id, turnId: id }).strict();
export const agentTurnStopRequestedDataSchema = z.object({ conversationId: id, turnId: id, requestedBy: id }).strict();

export const agentTurnFailedDataSchema = z
  .object({ conversationId: id, turnId: id, reason: reasonCodeSchema })
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

// Review text is encrypted with the conversation key. Digests bind it to the exact call.
export const toolApprovalRequestedDataSchema = z.object({
  approvalId: id, conversationId: id, turnId: id, assistantId: id, requesterId: id,
  tool: id, serverId: id, toolRevision: digestSchema, schemaDigest: digestSchema,
  connectionId: id, profile: id, policySequence: z.int().nonnegative(),
  digestVersion: z.literal('lossless-json-v1'), argumentsDigest: digestSchema,
  expiresAt: z.iso.datetime(), stepUp: z.boolean(),
  ciphertext: ciphertextSchema.max(32768), keyId: keyIdSchema, reviewDigest: digestSchema,
}).strict();

// Reviewed, credential-free tools declare every safe argument; unknown fields cannot be hidden.
const reviewText = z.string().trim().min(1).max(500);
const toolReviewSchema = z.object({
  action: reviewText, consequence: reviewText, targetArgument: id,
  fields: z.array(z.string().regex(/^[a-zA-Z][\w-]{0,63}$/u)).min(1).max(20),
  stepUp: z.boolean().default(false),
}).strict();

export const approvalExpiredDataSchema = z.object({ approvalId: id }).strict();

export const approvalUsedDataSchema = z.object({ approvalId: id, permitId: id }).strict();

export const effectUncertainDataSchema = z
  .object({ permitId: id, computerId: id, reason: z.enum(['settle_timeout', 'computer_lost', 'unknown_tariff', 'missing_usage', 'transport_failure']) })
  .strict();

// Evidence contains opaque receipt ids and hashes, never raw provider bodies or credentials.
const evidenceFields = { reference: z.string().regex(/^[\w-]{1,200}$/u), digest: digestSchema };
export const effectResolvedDataSchema = z.object({
  permitId: id, reservationId: id, resolvedBy: id, outcome: z.enum(['settled', 'released']), settledCents: centsSchema,
  evidence: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('provider_receipt'), ...evidenceFields, amountCents: centsSchema }).strict(),
    z.object({ kind: z.literal('dispatch_record'), ...evidenceFields, notDispatched: z.literal(true) }).strict(),
  ])).min(1).max(10),
}).strict().refine(d => d.outcome !== 'released' || d.settledCents === 0, 'Released calls have no cost');

// --- MCP catalogue, grants and connections ------------------------------

const mcpServerRegisteredFields = { serverId: id, registeredBy: id, catalogueRef: id.optional() };
export const mcpServerRegisteredDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote'), locator: remoteLocatorSchema, ...mcpServerRegisteredFields }).strict(),
  z.object({ kind: z.literal('hosted'), locator: hostedLocatorSchema, ...mcpServerRegisteredFields }).strict(),
]);

export const mcpServerDiscoveredDataSchema = z
  .object({
    serverId: id,
    toolCount: z.int().nonnegative(),
    schemaDigest: digestSchema,
    serverInfo: z.object({ name: id, version: id }).strict().optional(),
    discoverResult: z.string().max(65536).optional(),
    rejectedTools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/u).optional(),
      revision: digestSchema, reason: reasonCodeSchema }).strict()).max(1000).optional(),
    connectionId: id.optional(),
    accountMode: z.enum(['none', 'personal', 'company']).optional(),
    tools: z.array(z.object({ name: id, revision: digestSchema, reviewed: z.boolean(),
      readOnly: z.boolean().optional(), destructive: z.boolean().optional(), costCents: centsSchema.max(0).optional(), review: toolReviewSchema.optional(), definition: z.string().max(32768).optional() }).strict()).max(1000).optional(),
  })
  .strict();

export const mcpServerRejectedDataSchema = z
  .object({ serverId: id, reason: reasonCodeSchema })
  .strict();

export const mcpToolModeSetDataSchema = z
  .object({ serverId: id, toolName: id, connectionId: id.optional(), toolRevision: digestSchema.optional(), mode: z.enum(['allow', 'ask', 'block']), setBy: id })
  .strict();

export const mcpServerPublishedDataSchema = z
  .object({ serverId: id, publishedBy: id })
  .strict();

export const mcpServerUnpublishedDataSchema = z
  .object({ serverId: id, unpublishedBy: id })
  .strict();

// A registered MCP server's tool list or schemas changed (found by a drift
// check). The computer's own tools are a different event: toolset.changed.
export const mcpToolsChangedDataSchema = z
  .object({ serverId: id, previousSchemaDigest: digestSchema, newSchemaDigest: digestSchema })
  .strict();

export const grantGivenDataSchema = z
  .object({
    resourceType: id,
    resourceId: id,
    granteeId: id,
    granteeKind: z.enum(['member', 'team', 'assistant']),
    grantedBy: id,
  })
  .strict();

export const grantRevokedDataSchema = z
  .object({ resourceType: id, resourceId: id, granteeId: id, revokedBy: id })
  .strict();

// Risky type: the secret itself never appears here, only a reference id
// the secret store understands. userId, serverId and profile together
// identify the connection.
export const connectionCreatedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, secretRef: secretRefSchema })
  .strict();

export const connectionRefreshedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, secretRef: secretRefSchema })
  .strict();

export const connectionRevokedDataSchema = z
  .object({ userId: id, serverId: id, profile: id, revokedBy: id })
  .strict();

// --- Budgets (single-writer actor per silo) -----------------------------

// A ceiling or exhaustion applies to one scope: the whole silo ("global",
// no scopeId), one paying group, or one assistant (those two must name
// which one). Three strict shapes keyed on `scope` make "assistant with no
// scopeId" and "global with a scopeId" invalid instead of silently legal.
const ceilingFields = { ceilingCents: centsSchema, dailyCeilingCents: centsSchema.optional(), setBy: id };
export const budgetCeilingSetDataSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global'), ...ceilingFields, defaultPayingGroupId: id.optional() }).strict(),
  z.object({ scope: z.literal('paying_group'), scopeId: id, ...ceilingFields }).strict(),
  z.object({ scope: z.literal('assistant'), scopeId: id, ...ceilingFields }).strict(),
]);

// The reservation names both the paying group and the assistant, because
// the budget actor checks every ceiling (global, group, optional
// per-assistant) in the one append that records the charge.
export const budgetReservedDataSchema = z
  .object({ reservationId: id, permitId: id, amountCents: centsSchema, payingGroupId: id, assistantId: id,
    modelCall: z.object({ requestId: id.optional(), model: id, priceTableId: id, computerId: id, assistantId: id, requesterId: id, conversationId: id,
      turnId: id, threadId: id, payingGroupId: id.optional(), contextDigest: digestSchema }).strict().optional() })
  .strict();

export const budgetSettledDataSchema = z
  .object({ reservationId: id, permitId: id, settledCents: centsSchema, outcome: z.enum(['not_dispatched', 'unknown']).optional() })
  .strict()
  .refine(data => data.outcome !== 'not_dispatched' || data.settledCents === 0, 'Undispatched calls have no cost');

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
    reason: reasonCodeSchema,
    overrun: z.object({ model: id, reservedCents: centsSchema, settledCents: centsSchema }).strict().optional(),
    decision: z.object({ outcome: z.literal('deny'), requesterId: id.optional(), assistantId: id.optional(),
      contextDigest: digestSchema }).strict().optional(),
  })
  .strict();

// Server-owned admission and suspend fence; reports never carry this authority.
export const computerTurnStartedDataSchema = z.object({
  assistantId: id, computerId: id, conversationId: id, turnId: id, threadId: id, requesterId: id, task: z.literal('chat_turn'), payingGroupId: id.optional(),
}).strict();
export const computerTurnClosedDataSchema = computerTurnStartedDataSchema.extend({ threadId: id.optional(), status: z.enum(['completed', 'failed']) });

// Admission is separate from the later observed outcome. Unverified callers have no asserted identity.
export const decisionRecordedDataSchema = z.object({
  requestId: id, requesterId: id.optional(), assistantId: id.optional(),
  conversationId: id.optional(), turnId: id.optional(), permitId: id.optional(),
  route: z.enum(['model', 'mcp', 'egress']), outcome: z.enum(['allow', 'ask', 'deny']),
  reason: reasonCodeSchema, contextDigest: digestSchema,
}).strict();

// A view is a lease, never permission to control the desktop.
export const computerViewDataSchema = z.object({ sessionId: id, conversationId: id, computerId: id,
  assistantId: id, memberId: id, generation: z.int().positive(), expiresAt: z.iso.datetime({ offset: true }) }).strict();
export const computerViewStoppedDataSchema = computerViewDataSchema.extend({ reason: z.enum([
  'disconnected', 'access_changed', 'expired', 'protocol', 'slow_viewer', 'upstream', 'shutdown', 'unavailable',
]) });

export const computerViewRefusedDataSchema = z.object({
  attemptId: id,
  reason: z.enum(['admission', 'upgrade', 'capacity', 'unavailable']),
  conversationId: id.optional(),
}).strict();
