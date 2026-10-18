import type { BridgeReport } from './report-journal.ts';

export async function revokeTurnAccess<Grant>(
  turnId: string,
  waiting: Map<number, (grant: Grant | Error) => void>,
  reports: readonly BridgeReport[],
  revoke: () => Promise<void>,
  endHolds: () => void,
) {
  // Start revocation before releasing waits, which can otherwise resume a held call.
  const dropping = revoke();
  endHolds();
  for (const [sequence, settle] of waiting) {
    if (reports[sequence - 1]?.turnId !== turnId) continue;
    waiting.delete(sequence);
    settle(new Error('Turn ended'));
  }
  await dropping;
}
