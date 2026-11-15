import { setTimeout as pause } from 'node:timers/promises';
import { memberAuthorisation } from '@opencrane/authz';
import { onTestFinished, vi } from 'vitest';
import type { fixture } from '../fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

export function delayReceiptReplies(setup: Fixture) {
  const auth = memberAuthorisation(setup.binding);
  const checkApplied = auth.checkApplied.bind(auth);
  async function readApplied(eventId: string) {
    const result = await checkApplied(eventId);
    await pause(400);
    return result;
  }
  function restoreChecks() {
    vi.restoreAllMocks();
  }
  onTestFinished(restoreChecks);
  const appliedCheck = vi.spyOn(auth, 'checkApplied');
  appliedCheck.mockImplementation(readApplied);
}
