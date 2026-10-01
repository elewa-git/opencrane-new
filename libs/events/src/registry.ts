// The event-type registry: every event type named in
// docs/architecture/events.md, in code. This is the contract CI checks:
// scripts/check-event-catalogue.mjs fails the build if this list and the
// catalogue's tables ever disagree, in either direction.
//
// Each entry names:
// - the stream-type prefix the event belongs to (the "Streams" table,
//   e.g. `member-<user>`);
// - a strict zod schema for its `data`;
// - `example`: one valid `data` value, used by the generated tests in
//   test/generated-examples.test.ts.
import { z } from 'zod';
import {
  approvalDecidedDataSchema,
  effectObservedDataSchema,
  memberJoinedDataSchema,
  messagePostedDataSchema,
} from './examples.ts';
import * as data from './data.ts';

export interface EventDefinition<DataSchema extends z.ZodType = z.ZodType> {
  /** The event type, in past tense, e.g. "member.joined". */
  readonly type: string;
  /** The stream-type prefix this event is appended to, e.g. "member" for `member-<user>`. */
  readonly stream: string;
  /** One line describing what the event means. */
  readonly description: string;
  /** The zod schema for this event's `data` field. */
  readonly dataSchema: DataSchema;
  /** One valid `data` value for this event type. */
  readonly example: z.infer<DataSchema>;
}

// Builds one registry entry. `example` is typed against this call's own
// `dataSchema`, so an example that does not fit its schema is a compile
// error, not only a test failure.
function event<DataSchema extends z.ZodType>(
  type: string,
  stream: string,
  description: string,
  dataSchema: DataSchema,
  example: z.infer<DataSchema>,
): EventDefinition<DataSchema> {
  return { type, stream, description, dataSchema, example };
}

const DIGEST_EXAMPLE = '0123456789abcdef'.repeat(4);

export const eventRegistry: readonly EventDefinition[] = [
  // Organisation, members and teams
  event(
    'org.created',
    'org',
    'A new silo (customer organisation) was installed.',
    data.orgCreatedDataSchema,
    { orgName: 'Acme Ltd' },
  ),
  event(
    'member.invited',
    'member',
    'An admin invited someone to join.',
    data.memberInvitedDataSchema,
    { memberId: 'mem_2', email: 'bob@example.com', role: 'member', invitedBy: 'mem_1', invitationId: 'inv_1' },
  ),
  event(
    'member.joined',
    'member',
    'An invitation was accepted and the person became a member.',
    memberJoinedDataSchema,
    { memberId: 'mem_1', email: 'alice@example.com', displayName: 'Alice', role: 'member' },
  ),
  event(
    'member.role_changed',
    'member',
    "An admin changed a member's role.",
    data.memberRoleChangedDataSchema,
    { memberId: 'mem_1', previousRole: 'member', newRole: 'admin', changedBy: 'mem_2' },
  ),
  event(
    'member.removed',
    'member',
    'An admin removed a member from the silo.',
    data.memberRemovedDataSchema,
    { memberId: 'mem_1', removedBy: 'mem_2' },
  ),
  event('team.created', 'team', 'An admin created a team.', data.teamCreatedDataSchema, {
    teamId: 'team_1',
    name: 'Sales',
    createdBy: 'mem_1',
  }),
  event(
    'team.member_added',
    'team',
    'An admin added a member to a team.',
    data.teamMemberAddedDataSchema,
    { teamId: 'team_1', memberId: 'mem_1', addedBy: 'mem_2' },
  ),
  event(
    'team.member_removed',
    'team',
    'An admin removed a member from a team.',
    data.teamMemberRemovedDataSchema,
    { teamId: 'team_1', memberId: 'mem_1', removedBy: 'mem_2' },
  ),

  // Assistants and computers
  event(
    'assistant.created',
    'assistant',
    'A personal or team assistant was created (usually reacting to member.joined).',
    data.assistantCreatedDataSchema,
    { assistantId: 'asst_1', ownerId: 'mem_1', kind: 'personal' },
  ),
  event(
    'assistant.settings_changed',
    'assistant',
    "An owner or admin changed an assistant's model, persona or tools.",
    data.assistantSettingsChangedDataSchema,
    { assistantId: 'asst_1', changedBy: 'mem_1', changedFields: ['model'] },
  ),
  event(
    'computer.claimed',
    'computer',
    'The server bound a warm Pod to an assistant and issued its token.',
    data.computerClaimedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', podUid: 'pod-uid-1', generation: 1 },
  ),
  event(
    'computer.ready',
    'computer',
    'The bridge reported the computer is ready to receive work.',
    data.computerReadyDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1' },
  ),
  event(
    'computer.suspended',
    'computer',
    'The server suspended an idle computer to a snapshot.',
    data.computerSuspendedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', snapshotId: 'snap_1' },
  ),
  event(
    'computer.resumed',
    'computer',
    'The server resumed a computer from its snapshot.',
    data.computerResumedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', snapshotId: 'snap_1' },
  ),
  event(
    'computer.lost',
    'computer',
    "The computer's Pod disappeared unexpectedly.",
    data.computerLostDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1' },
  ),
  event(
    'computer.retired',
    'computer',
    'The computer was retired and its snapshots are due for deletion.',
    data.computerRetiredDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1' },
  ),
  event(
    'takeover.started',
    'computer',
    'A person started a live-view takeover of a computer.',
    data.takeoverStartedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', requestedBy: 'mem_1' },
  ),
  event(
    'takeover.ended',
    'computer',
    'A live-view takeover ended and control returned to the agent.',
    data.takeoverEndedDataSchema,
    { assistantId: 'asst_1', computerId: 'computer_1', endedBy: 'mem_1' },
  ),

  // Conversations and agent activity
  event(
    'conversation.created',
    'conversation',
    'A new conversation was started.',
    data.conversationCreatedDataSchema,
    { conversationId: 'conv_1', assistantId: 'asst_1', createdBy: 'mem_1' },
  ),
  event(
    'participant.added',
    'conversation',
    'Someone was added to a conversation.',
    data.participantAddedDataSchema,
    { conversationId: 'conv_1', participantId: 'mem_2', addedBy: 'mem_1' },
  ),
  event(
    'participant.removed',
    'conversation',
    'Someone was removed from a conversation.',
    data.participantRemovedDataSchema,
    { conversationId: 'conv_1', participantId: 'mem_2', removedBy: 'mem_1' },
  ),
  event(
    'message.posted',
    'conversation',
    'A person, or the system for a routine, posted a message into a conversation.',
    messagePostedDataSchema,
    {
      conversationId: 'conv_1',
      authorId: 'alice',
      authorKind: 'human',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
      keyId: 'key:1',
      contentType: 'text',
    },
  ),
  event(
    'agent.turn_started',
    'conversation',
    'The bridge reported that the assistant started a turn.',
    data.agentTurnStartedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', assistantId: 'asst_1' },
  ),
  event(
    'agent.turn_completed',
    'conversation',
    'The bridge reported that a turn finished.',
    data.agentTurnCompletedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1' },
  ),
  event(
    'agent.turn_failed',
    'conversation',
    'The bridge reported that a turn failed.',
    data.agentTurnFailedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', reason: 'model_error' },
  ),
  event(
    'agent.message_completed',
    'conversation',
    'The bridge reported a completed assistant message.',
    data.agentMessageCompletedDataSchema,
    {
      conversationId: 'conv_1',
      turnId: 'turn_1',
      messageId: 'msg_1',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
      keyId: 'key:1',
      contentType: 'text',
    },
  ),
  event(
    'agent.reasoning_summarised',
    'conversation',
    'The bridge reported a reasoning summary for a turn.',
    data.agentReasoningSummarisedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' },
  ),
  event(
    'agent.command_ran',
    'conversation',
    'The bridge reported a command the agent ran, with its exit status.',
    data.agentCommandRanDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', commandDigest: DIGEST_EXAMPLE, exitCode: 0 },
  ),
  event(
    'agent.file_changed',
    'conversation',
    'The bridge reported a file the agent changed in its workspace.',
    data.agentFileChangedDataSchema,
    { conversationId: 'conv_1', turnId: 'turn_1', path: 'notes/summary.md', changeType: 'created' },
  ),
  event(
    'conversation.closed',
    'conversation',
    'A conversation was closed; the computer should stop work on it.',
    data.conversationClosedDataSchema,
    { conversationId: 'conv_1', closedBy: 'mem_1' },
  ),

  // Tools, approvals and effects
  event(
    'tool.approval_requested',
    'approval',
    'The decision service refused a call in "Ask" mode and opened an approval.',
    data.toolApprovalRequestedDataSchema,
    {
      approvalId: 'appr_1',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      assistantId: 'asst_1',
      tool: 'odoo.write',
      argumentsDigest: DIGEST_EXAMPLE,
      requesterId: 'mem_1',
    },
  ),
  event(
    'approval.decided',
    'approval',
    'A person approved or rejected a pending tool call.',
    approvalDecidedDataSchema,
    { approvalId: 'appr_1', decision: 'approved', decidedBy: 'mem_1' },
  ),
  event(
    'approval.expired',
    'approval',
    'An approval timed out before anyone decided it.',
    data.approvalExpiredDataSchema,
    { approvalId: 'appr_1' },
  ),
  event(
    'approval.used',
    'approval',
    'A single-use approval was consumed by its matching retry.',
    data.approvalUsedDataSchema,
    { approvalId: 'appr_1', permitId: 'permit_1' },
  ),
  event(
    'effect.observed',
    'effect',
    'The gateway observed an external call (model, tool or web) complete.',
    effectObservedDataSchema,
    {
      permitId: 'permit_1',
      computerId: 'computer_1',
      tool: 'odoo.read',
      destination: 'odoo-mcp',
      costMinorUnits: 2,
      outcome: 'success',
    },
  ),
  event(
    'effect.uncertain',
    'effect',
    "An effect's outcome is unknown after a settle timeout or a lost computer.",
    data.effectUncertainDataSchema,
    { permitId: 'permit_1', computerId: 'computer_1', reason: 'settle_timeout' },
  ),
  event(
    'effect.resolved',
    'effect',
    'A person resolved an uncertain effect.',
    data.effectResolvedDataSchema,
    { permitId: 'permit_1', resolvedBy: 'mem_1', outcome: 'settled' },
  ),

  // MCP catalogue, grants and connections
  event(
    'mcp.server_registered',
    'mcp',
    'An admin registered a new MCP server in the catalogue (draft).',
    data.mcpServerRegisteredDataSchema,
    { serverId: 'mcp_1', kind: 'remote', locator: 'https://mcp.example.com', registeredBy: 'mem_1' },
  ),
  event(
    'mcp.server_discovered',
    'mcp',
    "Discovery read the server's tool list and schema digests.",
    data.mcpServerDiscoveredDataSchema,
    { serverId: 'mcp_1', toolCount: 3, schemaDigest: DIGEST_EXAMPLE },
  ),
  event(
    'mcp.server_rejected',
    'mcp',
    'Validation (SSRF guard or image scan) failed, so the server was rejected.',
    data.mcpServerRejectedDataSchema,
    { serverId: 'mcp_1', reason: 'ssrf_guard_failed' },
  ),
  event(
    'mcp.tool_mode_set',
    'mcp',
    'An admin set a tool to Allow automatically, Ask, or Block.',
    data.mcpToolModeSetDataSchema,
    { serverId: 'mcp_1', toolName: 'odoo.write', mode: 'ask', setBy: 'mem_1' },
  ),
  event(
    'mcp.server_published',
    'mcp',
    'An admin published an MCP server, generating its gateway route.',
    data.mcpServerPublishedDataSchema,
    { serverId: 'mcp_1', publishedBy: 'mem_1' },
  ),
  event(
    'mcp.server_unpublished',
    'mcp',
    'An admin unpublished an MCP server, removing its gateway route.',
    data.mcpServerUnpublishedDataSchema,
    { serverId: 'mcp_1', unpublishedBy: 'mem_1' },
  ),
  event(
    'mcp.tool_list_changed',
    'mcp',
    "A drift check found the server's tool list or schema changed.",
    data.mcpToolListChangedDataSchema,
    { serverId: 'mcp_1', previousSchemaDigest: DIGEST_EXAMPLE, newSchemaDigest: DIGEST_EXAMPLE.split('').reverse().join('') },
  ),
  event(
    'grant.given',
    'grant',
    'A shared resource was granted to a person, team or assistant.',
    data.grantGivenDataSchema,
    { resourceType: 'mcp_server', resourceId: 'mcp_1', granteeId: 'team_1', granteeKind: 'team', grantedBy: 'mem_1' },
  ),
  event(
    'grant.revoked',
    'grant',
    'A grant on a shared resource was revoked.',
    data.grantRevokedDataSchema,
    { resourceType: 'mcp_server', resourceId: 'mcp_1', granteeId: 'team_1', revokedBy: 'mem_1' },
  ),
  event(
    'connection.created',
    'connection',
    'A person completed a credential connection to an MCP server.',
    data.connectionCreatedDataSchema,
    { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', secretRef: 'secret:1' },
  ),
  event(
    'connection.refreshed',
    'connection',
    "A reaction refreshed a connection's OAuth token.",
    data.connectionRefreshedDataSchema,
    { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', secretRef: 'secret:2' },
  ),
  event(
    'connection.revoked',
    'connection',
    'A connection was revoked and its secret deleted.',
    data.connectionRevokedDataSchema,
    { userId: 'mem_1', serverId: 'mcp_1', profile: 'default', revokedBy: 'mem_1' },
  ),

  // Budgets
  event(
    'budget.ceiling_set',
    'budget',
    'An admin set a EUR ceiling (global, paying group, or assistant).',
    data.budgetCeilingSetDataSchema,
    { scope: 'global', ceilingMinorUnits: 500000, setBy: 'mem_1' },
  ),
  event(
    'budget.reserved',
    'budget',
    'The budget actor reserved the worst-case cost of a call.',
    data.budgetReservedDataSchema,
    { reservationId: 'res_1', permitId: 'permit_1', amountMinorUnits: 200, payingGroupId: 'team_1', assistantId: 'asst_1' },
  ),
  event(
    'budget.settled',
    'budget',
    'The budget actor settled a reservation against its observed effect.',
    data.budgetSettledDataSchema,
    { reservationId: 'res_1', permitId: 'permit_1', settledMinorUnits: 180 },
  ),
  event(
    'budget.period_started',
    'budget',
    'A new monthly budget period started.',
    data.budgetPeriodStartedDataSchema,
    { periodStart: '2026-10-01T00:00:00.000Z' },
  ),
  event(
    'budget.exhausted',
    'budget',
    'A budget ceiling was reached; affected work stops.',
    data.budgetExhaustedDataSchema,
    { scope: 'assistant', scopeId: 'asst_1' },
  ),

  // Company brain
  event(
    'memory.written',
    'scope',
    'The brain MCP wrote a memory into a permission scope.',
    data.memoryWrittenDataSchema,
    { scopeId: 'scope_1', memoryId: 'memory_1', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' },
  ),
  event(
    'memory.corrected',
    'scope',
    'The brain MCP corrected an existing memory.',
    data.memoryCorrectedDataSchema,
    { scopeId: 'scope_1', memoryId: 'memory_1', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:2' },
  ),
  event(
    'memory.forgotten',
    'scope',
    "A memory's key was deleted and a tombstone appended.",
    data.memoryForgottenDataSchema,
    { scopeId: 'scope_1', memoryId: 'memory_1' },
  ),
  event(
    'memory.consolidated',
    'scope',
    'A dreaming job consolidated memories for one scope.',
    data.memoryConsolidatedDataSchema,
    { scopeId: 'scope_1', consolidationId: 'consolidation_1', memoryIds: ['memory_1', 'memory_2'] },
  ),
  event(
    'scope.promotion_requested',
    'scope',
    'Someone asked to promote memory from one scope to a wider one.',
    data.scopePromotionRequestedDataSchema,
    { scopeId: 'scope_1', targetScopeId: 'scope_team_1', requestedBy: 'mem_1' },
  ),
  event(
    'scope.promoted',
    'scope',
    'An approver promoted memory to a wider scope.',
    data.scopePromotedDataSchema,
    { scopeId: 'scope_1', targetScopeId: 'scope_team_1', approvedBy: 'mem_2' },
  ),

  // Routines and delegation
  event(
    'routine.created',
    'routine',
    'A person created a scheduled routine.',
    data.routineCreatedDataSchema,
    { routineId: 'routine_1', assistantId: 'asst_1', schedule: '0 9 * * MON-FRI', createdBy: 'mem_1' },
  ),
  event(
    'routine.updated',
    'routine',
    'A person changed a scheduled routine.',
    data.routineUpdatedDataSchema,
    { routineId: 'routine_1', schedule: '0 8 * * MON-FRI', updatedBy: 'mem_1' },
  ),
  event(
    'routine.paused',
    'routine',
    'A person paused a scheduled routine.',
    data.routinePausedDataSchema,
    { routineId: 'routine_1', pausedBy: 'mem_1' },
  ),
  event(
    'routine.resumed',
    'routine',
    'A person resumed a paused routine.',
    data.routineResumedDataSchema,
    { routineId: 'routine_1', resumedBy: 'mem_1' },
  ),
  event(
    'routine.retired',
    'routine',
    'A person retired a scheduled routine.',
    data.routineRetiredDataSchema,
    { routineId: 'routine_1', retiredBy: 'mem_1' },
  ),
  event(
    'routine.due',
    'routine',
    'The scheduler fired a routine; exactly one firing is emitted.',
    data.routineDueDataSchema,
    { routineId: 'routine_1', firedAt: '2026-10-01T09:00:00.000Z' },
  ),
  event(
    'delegation.started',
    'delegation',
    'A parent computer delegated work to a child sub-agent.',
    data.delegationStartedDataSchema,
    { delegationId: 'deleg_1', parentComputerId: 'computer_1', childComputerId: 'computer_2', rootBudgetId: 'budget_acme' },
  ),
  event(
    'delegation.completed',
    'delegation',
    "A child computer's delegated work finished.",
    data.delegationCompletedDataSchema,
    { delegationId: 'deleg_1', outcome: 'success' },
  ),

  // Security
  event(
    'security.alert_raised',
    'security',
    'A reaction raised a security alert for admins to review.',
    data.securityAlertRaisedDataSchema,
    { alertId: 'alert_1', severity: 'high', reason: 'effect_without_permit' },
  ),
];

const registryByType = new Map(eventRegistry.map((entry) => [entry.type, entry]));

export function getEventDefinition(type: string): EventDefinition | undefined {
  return registryByType.get(type);
}

export function listEventTypes(): string[] {
  return eventRegistry.map((entry) => entry.type);
}
