export function deferredReply() {
  let release: (response: Response) => void = missingRelease;
  function missingRelease(): void {
    throw new Error('The reply was not held');
  }
  function hold(resolve: (response: Response) => void): void {
    release = resolve;
  }
  const promise = new Promise<Response>(hold);
  return { promise, release };
}
