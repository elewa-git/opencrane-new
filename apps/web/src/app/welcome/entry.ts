import { z } from 'zod';

const paths = {
  survey: '/welcome/survey',
  persona: '/welcome/persona',
  welcome: '/welcome',
  workspace: '/workspace',
} as const;
const entrySchema = z.object({ next: z.enum(['survey', 'persona', 'welcome', 'workspace']) });

export async function onboardingEntry(signal: AbortSignal, justJoined = false) {
  const deadline = AbortSignal.timeout(10_000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  while (!requestSignal.aborted) {
    const response = await fetch('/api/onboarding/entry', {
      cache: 'no-store', signal: requestSignal,
    });
    // Give the membership and permission workers time to apply a confirmed invitation.
    if (response.status === 425 || (justJoined && response.status === 403)) {
      await new Promise<void>(waitForMembership);
      continue;
    }
    if ([204, 401, 403].includes(response.status)) return undefined;
    if (!response.ok) throw new Error('Onboarding progress unavailable');
    const body: unknown = await response.json();
    const { next } = entrySchema.parse(body);
    return paths[next];
  }
  throw new Error('Onboarding progress check timed out');
}

function waitForMembership(resolve: () => void) {
  setTimeout(resolve, 300);
}
