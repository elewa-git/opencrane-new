export type ApprovalReadPurpose = 'poll' | 'decision' | 'check';

export function approvalReadSignal(
  abortSignal: AbortSignal | undefined,
  purpose: ApprovalReadPurpose,
): AbortSignal {
  const timeout = AbortSignal.timeout(15000);
  // Stop a stuck check so it cannot block later checks when a laptop wakes.
  if (purpose === 'poll' && abortSignal) {
    return AbortSignal.any([abortSignal, timeout]);
  }
  return abortSignal ?? timeout;
}
