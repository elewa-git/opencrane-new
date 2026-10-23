import { z } from 'zod';
import { gatewayObservationSchema } from '@opencrane/events';
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
  checkReviewedTools(data.policy);
  checkGrants(data);
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

function checkReviewedTools(policy: Evidence['policy']) {
  requireEvidence(policy.tools.length === 2);
  for (const tool of policy.tools) {
    const read = tool.name === 'read_fixture_quote' && tool.mode === 'allow' && tool.readOnly;
    const write = tool.name === 'change_delivery_slot' && tool.mode === 'ask' && !tool.readOnly;
    requireEvidence(tool.reviewed && tool.costCents === 0 && (read || write));
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

function toolName(tool: z.output<typeof toolPolicySchema>['tools'][number]) {
  return tool.name;
}
function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('Approval evidence refused');
}
