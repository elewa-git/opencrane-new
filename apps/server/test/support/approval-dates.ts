export const datedApprovalEnds = [
  ['approval.decided', { decision: 'approved', decidedBy: 'alice' }, 'approved',
    { decidedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.decided', { decision: 'rejected', decidedBy: 'alice' }, 'denied',
    { decidedAt: '2026-10-12T10:01:00.000Z', endedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.expired', {}, 'expired', { endedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.cancelled', {}, 'cancelled', { endedAt: '2026-10-12T10:01:00.000Z' }],
  ['approval.used', { permitId: 'dated-permit' }, 'outcome_unknown',
    { usedAt: '2026-10-12T10:01:00.000Z',
      uses: [{ permitId: 'dated-permit', usedAt: '2026-10-12T10:01:00.000Z' }] }],
] as const;
