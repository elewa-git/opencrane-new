import { z } from 'zod';
import { isToolPolicyAvailable } from '@opencrane/projections';
import { validateMcpCatalogue } from '@opencrane/events/mcp-catalogue';
import { gatewayObservationSchema, eventEnvelopeSchema, toolApprovalRequestedDataSchema,
  approvalDecidedDataSchema, approvalUsedDataSchema, decisionRecordedDataSchema,
  toolDispatchRecordedDataSchema } from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';
import { modelAccessChangeSchema, modelAccessCommandSchema, toolPolicySchema }
  from '@opencrane/protocol';

const modelIdField = { modelId: true } as const;
const receiptWithoutModel = modelAccessChangeSchema.omit(modelIdField);
const serverIdField = { serverId: z.string() };
const receipt = receiptWithoutModel.extend(serverIdField);
const readback = z.strictObject({ quoteId: z.literal('DEMO-001'), amountCents: z.literal(12500),
  slot: z.enum(['morning', 'afternoon']), effectCount: z.int().nonnegative() });
const evidenceSchema = z.strictObject({
  policy: toolPolicySchema,
  rehearsedAt: z.iso.datetime(),
  conversationId: z.string().min(1), callId: z.string().min(1),
  records: z.strictObject({
    request: recordedEvent('tool.approval_requested', toolApprovalRequestedDataSchema),
    approvalDecision: recordedEvent('approval.decided', approvalDecidedDataSchema),
    approvalUse: recordedEvent('approval.used', approvalUsedDataSchema),
    dispatchDecision: recordedEvent('decision.recorded', decisionRecordedDataSchema),
    dispatch: recordedEvent('tool.dispatch_recorded', toolDispatchRecordedDataSchema),
  }),
  publicationCommandId: z.string().min(1),
  gateway: gatewayObservationSchema,
  grants: z.array(z.strictObject({ command: modelAccessCommandSchema, receipt })),
  before: readback, waiting: readback, after: readback,
  turnId: z.string().min(1), replyTurnId: z.string().min(1),
  requesterId: z.string().min(1), assistantId: z.string().min(1),
  approval: z.strictObject({ decision: z.literal('approve'), decidedBy: z.string().min(1),
    turnId: z.string().min(1) }),
  toolReservedCents: z.literal(0), toolChargedCents: z.literal(0),
});
export type StageBApprovalEvidence = z.input<typeof evidenceSchema>;
type Evidence = z.output<typeof evidenceSchema>;

export function checkStageBApproval(input: unknown) {
  const parsed = evidenceSchema.safeParse(input);
  requireEvidence(parsed.success);
  const data = parsed.data;
  checkPublication(data);
  checkReviewedTools(data.policy, Date.parse(data.rehearsedAt));
  checkGrants(data);
  checkApprovalRecords(data);
  requireEvidence(data.before.effectCount === 0 && data.before.slot === 'morning');
  requireEvidence(data.waiting.effectCount === 0 && data.waiting.slot === 'morning');
  requireEvidence(data.after.effectCount === 1 && data.after.slot === 'afternoon');
  requireEvidence(data.approval.decidedBy === data.requesterId);
  requireEvidence(data.approval.turnId === data.turnId && data.replyTurnId === data.turnId);
}

function checkPublication(data: Evidence) {
  const policy = data.policy;
  const publication = policy.publication;
  const observed = policy.configurationObservation;
  requireEvidence(policy.published && !policy.rejected && !policy.driftHeld);
  requireEvidence(publication && observed);
  requireEvidence(publication.commandId === data.publicationCommandId);
  requireEvidence(publication.serverId === policy.serverId && observed.serverId === policy.serverId);
  requireEvidence(observed.changeRef === publication.commandId);
  requireEvidence(observed.reviewRevision === publication.reviewRevision &&
    policy.reviewRevision === publication.reviewRevision);
  requireEvidence(observed.fragmentDigest === publication.fragmentDigest);
  requireEvidence(observed.sourceSequence === policy.publicationRevision);
  requireEvidence(observed.generation === data.gateway.generation &&
    observed.recordDigest === data.gateway.recordDigest &&
    observed.configDigest === data.gateway.configDigest &&
    observed.processRef === data.gateway.processRef);
}

function checkReviewedTools(policy: Evidence['policy'], rehearsedAt: number) {
  requireEvidence(isToolPolicyAvailable(policy, rehearsedAt));
  const catalogue = policy.catalogue;
  requireEvidence(catalogue && catalogue.serverId === policy.serverId);
  try {
    validateMcpCatalogue(catalogue);
  } catch {
    throw new Error('Approval evidence refused');
  }
  const declarations = catalogue.tools;
  requireEvidence(policy.tools.length === 2 && declarations?.length === 2);
  for (const tool of policy.tools) {
    const read = tool.name === 'read_fixture_quote' && tool.mode === 'allow' && tool.readOnly;
    const write = tool.name === 'change_delivery_slot' && tool.mode === 'ask' && !tool.readOnly;
    requireEvidence(tool.reviewed && tool.costCents === 0 && (read || write));
    function matchesName(declaration: NonNullable<typeof declarations>[number]) {
      return declaration.name === tool.name;
    }
    const declaration = declarations.find(matchesName);
    requireEvidence(declaration?.revision === tool.revision);
    requireEvidence(declaration?.readOnly === tool.readOnly && declaration.costCents === 0);
    requireEvidence(declaration.review);
  }
  const names = policy.tools.map(toolName);
  const toolNames = new Set(names);
  requireEvidence(toolNames.size === 2);
}

function checkGrants(data: Evidence) {
  requireEvidence(data.grants.length === 2);
  const kinds = new Set<string>();
  const changes = new Set<string>();
  for (const grant of data.grants) {
    const saved = grant.receipt;
    const command = grant.command;
    const member = command.granteeKind === 'member' && command.granteeId === data.requesterId;
    const assistant = command.granteeKind === 'assistant' && command.granteeId === data.assistantId;
    requireEvidence((member || assistant) && command.action === 'grant');
    requireEvidence(saved.commandId === command.commandId && saved.serverId === data.policy.serverId);
    requireEvidence(saved.operation === 'grant.given');
    requireEvidence(saved.projection.content === 'current' && saved.projection.iam === 'current');
    kinds.add(command.granteeKind);
    changes.add(saved.changeId);
  }
  requireEvidence(kinds.size === 2 && changes.size === 2);
}

function checkApprovalRecords(data: Evidence) {
  const records = data.records;
  const request = records.request.event.data;
  const decision = records.approvalDecision.event.data;
  const use = records.approvalUse.event.data;
  const dispatchDecision = records.dispatchDecision.event;
  const dispatch = records.dispatch.event.data;
  checkRecordOrder(data);
  checkApprovalRequest(data);
  requireEvidence(decision.approvalId === request.approvalId && decision.decision === 'approved');
  requireEvidence(decision.decidedBy === data.requesterId);
  requireEvidence(use.approvalId === request.approvalId && use.permitId === dispatch.requestId);
  requireEvidence(dispatchDecision.correlation.approval === request.approvalId);
  requireEvidence(dispatch.approvalId === request.approvalId);
  requireEvidence(Date.parse(dispatch.startedAt) >= Date.parse(dispatchDecision.time));
  requireEvidence(Date.parse(dispatch.startedAt) <= Date.parse(records.dispatch.event.time));
  requireEvidence(Date.parse(dispatch.startedAt) < Date.parse(request.expiresAt));
  checkDispatchRecords(data);
}

function checkRecordOrder(data: Evidence) {
  const records = data.records;
  const ordered = [records.request, records.approvalDecision, records.approvalUse,
    records.dispatchDecision, records.dispatch];
  const approvalId = records.request.event.data.approvalId;
  const requestId = records.dispatch.event.data.requestId;
  let previousSequence = 0;
  let previousTime = -Infinity;
  const ids = new Set<string>();
  for (const record of ordered) {
    const event = record.event;
    const approval = event.type === 'tool.approval_requested' ||
      event.type === 'approval.decided' || event.type === 'approval.used';
    const subject = approval ? `approval-${approvalId}` : `decision-${requestId}`;
    const time = Date.parse(event.time);
    requireEvidence(event.silo === data.policy.silo && event.subject === subject);
    // Compare global event positions across streams to prove the saved order.
    requireEvidence(record.sequence > previousSequence && time >= previousTime);
    requireEvidence(!ids.has(event.id) && time <= Date.parse(data.rehearsedAt));
    ids.add(event.id);
    previousSequence = record.sequence;
    previousTime = time;
  }
}

function checkApprovalRequest(data: Evidence) {
  const request = data.records.request.event.data;
  const catalogue = data.policy.catalogue;
  requireEvidence(request.requesterId === data.requesterId);
  requireEvidence(request.assistantId === data.assistantId);
  requireEvidence(request.conversationId === data.conversationId && request.turnId === data.turnId);
  requireEvidence(request.serverId === data.policy.serverId);
  requireEvidence(request.connectionId === data.policy.connectionId && request.profile === 'none');
  requireEvidence(request.tool === 'change_delivery_slot');
  function isWriteTool(tool: Evidence['policy']['tools'][number]) {
    return tool.name === request.tool;
  }
  const writeTool = data.policy.tools.find(isWriteTool);
  requireEvidence(request.toolRevision === writeTool?.revision);
  requireEvidence(request.schemaDigest === catalogue?.schemaDigest);
  requireEvidence(request.policySequence === data.policy.policyRevision);
  const argumentsJson = '{"quoteId":"DEMO-001","slot":"afternoon"}';
  requireEvidence(request.argumentsDigest === losslessJson(argumentsJson).digest);
}

function checkDispatchRecords(data: Evidence) {
  const decisionEvent = data.records.dispatchDecision.event;
  const decision = decisionEvent.data;
  const dispatch = data.records.dispatch.event.data;
  requireEvidence(decision.route === 'mcp' && decision.outcome === 'allow');
  requireEvidence(decision.reason === 'approval_used' && decision.requestId === dispatch.requestId);
  requireEvidence(decision.requesterId === data.requesterId &&
    decision.assistantId === data.assistantId);
  requireEvidence(decision.logicalRequestId === dispatch.logicalRequestId);
  for (const call of [decision, dispatch]) {
    requireEvidence(call.callId === data.callId && call.turnId === data.turnId);
    requireEvidence(call.conversationId === data.conversationId);
    requireEvidence(call.serverId === data.policy.serverId);
    requireEvidence(call.toolName === 'change_delivery_slot');
  }
  requireEvidence(dispatch.outcome === 'responded');
  requireEvidence(dispatch.evidence === 'response_received' ||
    dispatch.evidence === 'adapter_response_received');
  const adapter = dispatch.adapter;
  if (adapter) {
    requireEvidence(adapter.decisionId === decisionEvent.id);
    requireEvidence(adapter.connectionId === data.policy.connectionId);
    requireEvidence(adapter.reviewRevision === data.policy.reviewRevision);
    requireEvidence(adapter.generation === data.gateway.generation &&
      adapter.recordDigest === data.gateway.recordDigest);
  }
}

function toolName(tool: z.output<typeof toolPolicySchema>['tools'][number]) {
  return tool.name;
}
function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('Approval evidence refused');
}

function recordedEvent<Data extends z.ZodType>(type: string, data: Data) {
  const event = eventEnvelopeSchema(data).extend({ type: z.literal(type) });
  return z.strictObject({ sequence: z.int().positive(), event });
}
