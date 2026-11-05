// Release the caller even when the browser operation cannot be cancelled, such as copying text.
export function untilAborted<Result>(
  pending: Promise<Result>, signal: AbortSignal | undefined,
): Promise<Result> {
  function wait(
    resolve: ((value: Result) => void) | undefined,
    reject: ((reason: unknown) => void) | undefined,
  ): void {
    function stopWaiting(): void {
      signal?.removeEventListener('abort', cancelled);
      // Detach the settled promise and abort reason from the operation still held by the browser.
      signal = undefined;
      resolve = undefined;
      reject = undefined;
    }
    function cancelled(): void {
      const rejectWait = reject;
      stopWaiting();
      rejectWait?.(new Error('Operation cancelled'));
    }
    function completed(value: Result): void {
      const resolveWait = resolve;
      stopWaiting();
      resolveWait?.(value);
    }
    function failed(reason: unknown): void {
      const rejectWait = reject;
      stopWaiting();
      rejectWait?.(reason);
    }
    void pending.then(completed, failed);
    if (signal?.aborted) {
      cancelled();
    } else {
      signal?.addEventListener('abort', cancelled);
    }
  }
  return new Promise(wait);
}
