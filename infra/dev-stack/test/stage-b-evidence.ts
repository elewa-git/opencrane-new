import { catalogue } from '../../../apps/demo-mcp/src/tools.ts';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
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
