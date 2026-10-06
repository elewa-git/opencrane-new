export type ApprovalReadPurpose = 'poll' | 'decision' | 'check';

export function approvalReadSignal(
  abortSignal: AbortSignal | undefined,
  purpose: ApprovalReadPurpose,
): AbortSignal {
  const timeout = AbortSignal.timeout(15000);
  // End a stuck poll so it cannot block every poll after a laptop wakes.
  if (purpose === 'poll' && abortSignal) {
    return AbortSignal.any([abortSignal, timeout]);
  }
  return abortSignal ?? timeout;
}
