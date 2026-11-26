interface ReadRetry {
  attempts: number;
  delayMs: number;
  shouldRetry: (response: Response) => boolean | Promise<boolean>;
}

export async function retryRead(read: (signal: AbortSignal) => Promise<Response>,
  caller: AbortSignal | null | undefined, retry: ReadRetry): Promise<Response> {
  const deadline = AbortSignal.timeout(10_000);
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    const response = await read(signal);
    const decision = retry.shouldRetry(response);
    const again = typeof decision === 'boolean' ? decision : await decision;
    signal.throwIfAborted();
    if (!again || attempt === retry.attempts) {
      return response;
    }
    if (!response.bodyUsed) {
      await response.body?.cancel();
    }
    await waitForRead(retry.delayMs, signal);
  }
}

export function waitForRead(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(schedule);

  function schedule(resolve: () => void) {
    const timer = globalThis.setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) {
      finish();
    }

    function finish() {
      globalThis.clearTimeout(timer);
      // Remove the listener after each wait so later reads do not retain old timers.
      signal.removeEventListener('abort', finish);
      resolve();
    }
  }
}
