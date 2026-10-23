import type { StageBApprovalEvidence } from '../stage-b-evidence.ts';

export function approvalEvidence(): StageBApprovalEvidence {
  const fragmentDigest = 'a'.repeat(64);
  const publication = { serverId: 'demo', publishedBy: 'admin', commandId: 'publish-demo',
    expectedSequence: 3, reviewRevision: 3, fragmentDigest };
  const configurationObservation = { serverId: 'demo', changeRef: 'publish-demo',
    reviewRevision: 3, fragmentDigest, sourceSequence: 4, generation: 1,
    recordDigest: 'b'.repeat(64), configDigest: 'c'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', observedAt: '2026-10-23T10:00:00Z' };
  const before = { quoteId: 'DEMO-001', amountCents: 12500, slot: 'morning', effectCount: 0 };
  return {
    policy: { silo: 'dev', serverId: 'demo', connectionId: 'connection', accountMode: 'none',
      published: true, sequence: 5, policyRevision: 3, reviewRevision: 3,
      publication, publicationRevision: 4, configurationObservation,
      tools: [
        { name: 'read_fixture_quote', revision: fragmentDigest, reviewed: true,
          readOnly: true, costCents: 0, mode: 'allow', suggestion: 'allow' },
        { name: 'change_delivery_slot', revision: fragmentDigest, reviewed: true,
          readOnly: false, costCents: 0, mode: 'ask', suggestion: 'ask' },
      ] },
    grants: [grant('member'), grant('assistant')],
    before, waiting: { ...before }, after: { ...before, slot: 'afternoon', effectCount: 1 },
    turnId: 'turn', replyTurnId: 'turn', requesterId: 'member',
    approval: { decision: 'approve', decidedBy: 'member', turnId: 'turn' },
    toolReservedCents: 0, toolChargedCents: 0,
  };
}

function grant(kind: 'member' | 'assistant') {
  const commandId = `grant-${kind}`;
  const receipt = { status: 'appended' as const, serverId: 'demo', commandId,
    operation: 'grant.given' as const, sequence: 1, changeId: commandId, currentSequence: 1,
    projection: { content: 'current' as const, iam: 'current' as const } };
  return { kind, commandId, receipt };
}
