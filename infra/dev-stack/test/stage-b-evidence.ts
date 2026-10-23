import { catalogue } from '../../../apps/demo-mcp/src/tools.ts';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import type { CorrelationIds } from '@opencrane/events';
import type { StageBApprovalEvidence } from '../stage-b-evidence.ts';

export function approvalEvidence(): StageBApprovalEvidence {
  const fragmentDigest = 'a'.repeat(64);
  const tools = catalogue.tools.map(savedTool);
  const savedCatalogue = { serverId: 'demo', toolCount: 2, tools,
    schemaDigest: catalogueDigest(tools), connectionId: 'connection',
    accountMode: 'none' as const };
  const publication = { serverId: 'demo', publishedBy: 'admin', commandId: 'publish-demo',
    expectedSequence: 3, reviewRevision: 3, fragmentDigest };
  const configurationObservation = { serverId: 'demo', changeRef: 'publish-demo',
    reviewRevision: 3, fragmentDigest, sourceSequence: 4, generation: 1,
    recordDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', observedAt: '2026-10-23T10:00:00Z' };
  const before = { quoteId: 'DEMO-001' as const, amountCents: 12500 as const,
    slot: 'morning' as const, effectCount: 0 };
  return {
    callId: 'call', conversationId: 'conversation',
    records: approvalRecords(tools[1]!.revision, savedCatalogue.schemaDigest),
    rehearsedAt: '2026-10-23T10:01:00Z',
    publicationCommandId: publication.commandId,
    gateway: { generation: configurationObservation.generation,
      recordDigest: configurationObservation.recordDigest,
      configDigest: configurationObservation.configDigest,
      processRef: configurationObservation.processRef, outcome: 'loaded',
      observedAt: configurationObservation.observedAt },
    policy: { silo: 'dev', serverId: 'demo', connectionId: 'connection', accountMode: 'none',
      published: true, sequence: 5, policyRevision: 3, reviewRevision: 3,
      publication, publicationRevision: 4, configurationObservation,
      catalogue: savedCatalogue, checkedAt: '2026-10-23T10:00:00Z',
      expiresAt: '2026-10-23T10:05:00Z',
      tools: [
        { name: 'read_fixture_quote', revision: tools[0]!.revision, reviewed: true,
          readOnly: true, costCents: 0, mode: 'allow', suggestion: 'allow' },
        { name: 'change_delivery_slot', revision: tools[1]!.revision, reviewed: true,
          readOnly: false, costCents: 0, mode: 'ask', suggestion: 'ask' },
      ] },
    grants: [grant('member'), grant('assistant')],
    before, waiting: { ...before }, after: { ...before, slot: 'afternoon', effectCount: 1 },
    turnId: 'turn', replyTurnId: 'turn', requesterId: 'member', assistantId: 'assistant',
    approval: { decision: 'approve', decidedBy: 'member', turnId: 'turn' },
    toolReservedCents: 0, toolChargedCents: 0,
  };
}

function grant(kind: 'member' | 'assistant') {
  const commandId = `grant-${kind}`;
  const receipt = { status: 'appended' as const, serverId: 'demo', commandId,
    operation: 'grant.given' as const, sequence: 1, changeId: commandId, currentSequence: 1,
    projection: { content: 'current' as const, iam: 'current' as const } };
  const command = { commandId, expectedSequence: 0, action: 'grant' as const,
    granteeKind: kind, granteeId: kind };
  return { command, receipt };
}

function savedTool(tool: typeof catalogue.tools[number]) {
  const encoded = JSON.stringify(tool);
  const parsed = losslessJson(encoded);
  return { name: tool.name, definition: parsed.canonical, revision: parsed.digest,
    reviewed: false, readOnly: tool.annotations.readOnlyHint,
    destructive: tool.annotations.destructiveHint, costCents: 0 as const,
    review: tool._meta['io.opencrane/review'] };
}

function approvalRecords(toolRevision: string, schemaDigest: string) {
  const approvalId = 'approval';
  const requestId = '00000000-0000-4000-8000-000000000010';
  const logicalRequestId = 'd'.repeat(64);
  const argumentsDigest = losslessJson('{"quoteId":"DEMO-001","slot":"afternoon"}').digest;
  const requestData = { approvalId, conversationId: 'conversation', turnId: 'turn',
    assistantId: 'assistant', requesterId: 'member', tool: 'change_delivery_slot',
    serverId: 'demo', toolRevision, schemaDigest, connectionId: 'connection',
    profile: 'none', policySequence: 3, digestVersion: 'lossless-json-v1' as const, argumentsDigest,
    expiresAt: '2026-10-23T10:04:00Z', stepUp: false,
    ciphertext: Buffer.from('synthetic-encrypted-review').toString('base64'),
    keyId: 'key:synthetic-review', reviewDigest: 'e'.repeat(64) };
  const approvalSubject = `approval-${approvalId}`;
  const request = record('tool.approval_requested', requestData, 10,
    '2026-10-23T10:00:10Z', approvalSubject);
  const approvalDecision = record('approval.decided',
    { approvalId, decidedBy: 'member', decision: 'approved' as const }, 11,
    '2026-10-23T10:00:20Z', approvalSubject);
  const approvalUse = record('approval.used', { approvalId, permitId: requestId }, 12,
    '2026-10-23T10:00:21Z', approvalSubject);
  const decisionData = { callId: 'call', logicalRequestId, serverId: 'demo',
    toolName: 'change_delivery_slot', requestId, requesterId: 'member', assistantId: 'assistant',
    conversationId: 'conversation', turnId: 'turn', route: 'mcp' as const, outcome: 'allow' as const,
    reason: 'approval_used', contextDigest: 'f'.repeat(64) };
  const dispatchDecision = record('decision.recorded', decisionData, 13,
    '2026-10-23T10:00:22Z', `decision-${requestId}`, { approval: approvalId });
  const dispatchData = { conversationId: 'conversation', turnId: 'turn', callId: 'call',
    serverId: 'demo', toolName: 'change_delivery_slot', requestId, logicalRequestId, approvalId,
    startedAt: '2026-10-23T10:00:22Z', durationMs: 10, outcome: 'responded' as const,
    evidence: 'response_received' as const };
  const dispatch = record('tool.dispatch_recorded', dispatchData, 14,
    '2026-10-23T10:00:23Z', `decision-${requestId}`);
  return { request, approvalDecision, approvalUse, dispatchDecision, dispatch };
}

function record<Data>(type: string, data: Data, sequence: number, time: string,
  subject: string, correlation: CorrelationIds = {}) {
  const event = { id: `synthetic-${sequence}`, type, source: 'synthetic-test',
    silo: 'dev', time, subject, correlation, data };
  return { sequence, event };
}
