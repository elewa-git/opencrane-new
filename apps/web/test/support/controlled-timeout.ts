export function controlledTimeout(ms: number): AbortSignal {
  const deadline = new AbortController();
  function expire() {
    deadline.abort(new DOMException('Read timed out', 'TimeoutError'));
  }
  globalThis.setTimeout(expire, ms);
  return deadline.signal;
}
