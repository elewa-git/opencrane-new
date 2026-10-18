import type { ClientRequest, ServerResponse } from 'node:http';

export function proxyRequests() {
  const active = new Map<string, Set<() => void>>();

  function track(thread: string, outgoing: ClientRequest, response: ServerResponse) {
    const requests = active.get(thread) ?? new Set<() => void>();
    active.set(thread, requests);
    function abort() {
      outgoing.destroy();
      if (!response.writableEnded) response.destroy();
    }
    function disconnected() {
      outgoing.destroy();
      requests.delete(abort);
      if (!requests.size && active.get(thread) === requests) active.delete(thread);
    }
    requests.add(abort);
    // Keep tracking until the client finishes, even if the upstream has already replied.
    response.once('close', disconnected);
  }

  function drop(thread: string) {
    const requests = active.get(thread);
    active.delete(thread);
    for (const abort of requests ?? []) abort();
  }

  return { track, drop };
}
