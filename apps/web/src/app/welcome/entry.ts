import { z } from 'zod';

const paths = {
  survey: '/welcome/survey',
  persona: '/welcome/persona',
  welcome: '/welcome',
  workspace: '/workspace',
} as const;
const entrySchema = z.object({ next: z.enum(['survey', 'persona', 'welcome', 'workspace']) });
type EntryResult = { kind: 'destination'; path: string } |
  { kind: 'disabled' } | { kind: 'signed-out' } | { kind: 'denied' };

class EntryRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('Onboarding progress unavailable');
    this.status = status;
  }
}

export async function onboardingEntry(signal: AbortSignal, justJoined = false) {
  const deadline = new AbortController();
  const requestSignal = AbortSignal.any([signal, deadline.signal]);
  function expire() {
    deadline.abort(new DOMException('Onboarding progress check timed out', 'TimeoutError'));
  }
  const timer = setTimeout(expire, 10_000);
  try {
    return await readEntry(requestSignal, justJoined);
  } finally {
    clearTimeout(timer);
  }
}

async function readEntry(signal: AbortSignal, justJoined: boolean): Promise<EntryResult> {
  for (;;) {
    signal.throwIfAborted();
    const response = await fetch('/api/onboarding/entry', { cache: 'no-store', signal });
    signal.throwIfAborted();
    // Give the membership and permission workers time to apply a confirmed invitation.
    if (response.status === 425 || (justJoined && response.status === 403)) {
      await waitForMembership(signal);
      continue;
    }
    return parseEntry(response);
  }
}

async function parseEntry(response: Response): Promise<EntryResult> {
  switch (response.status) {
    case 204:
      return { kind: 'disabled' };
    case 401:
      return { kind: 'signed-out' };
    case 403:
      return { kind: 'denied' };
  }
  if (!response.ok) {
    throw new EntryRequestError(response.status);
  }
  const body: unknown = await response.json();
  const { next } = entrySchema.parse(body);
  return { kind: 'destination', path: paths[next] };
}

function waitForMembership(signal: AbortSignal) {
  function wait(resolve: () => void, reject: (reason: unknown) => void) {
    function ready() {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    const timer = setTimeout(ready, 300);
    signal.addEventListener('abort', cancel, { once: true });
  }
  return new Promise<void>(wait);
}

export function reportEntryFailure(error: unknown, page: 'sign-in' | 'invitation' | 'workspace') {
  let cause: string | number = 'unexpected';
  if (error instanceof EntryRequestError) {
    cause = error.status;
  } else if (error instanceof z.ZodError) {
    cause = 'invalid response';
  } else if (error instanceof SyntaxError) {
    cause = 'invalid JSON';
  } else if (error instanceof TypeError) {
    cause = 'network';
  } else if (error instanceof DOMException && error.name === 'TimeoutError') {
    cause = 'timeout';
  }
  // Give the cause without recording the contents of a reply or an exception.
  console.warn('Could not check welcome progress', { page, cause });
}
