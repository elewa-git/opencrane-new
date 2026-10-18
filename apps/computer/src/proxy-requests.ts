import type { ClientRequest, ServerResponse } from 'node:http';

export function proxyRequests() {
  const active = new Map<string, Set<() => void>>();

  function track(turnId: string, outgoing: ClientRequest, response: ServerResponse) {
    const requests = active.get(turnId) ?? new Set<() => void>();
    active.set(turnId, requests);
    function abort() {
      outgoing.destroy();
      if (!response.writableEnded) response.destroy();
    }
    function disconnected() {
      outgoing.destroy();
      requests.delete(abort);
      if (!requests.size && active.get(turnId) === requests) active.delete(turnId);
    }
    requests.add(abort);
    // Keep tracking until the client finishes, even if the upstream has already replied.
    response.once('close', disconnected);
  }

  function drop(turnId: string) {
    const requests = active.get(turnId);
    active.delete(turnId);
    for (const abort of requests ?? []) abort();
  }

  return { track, drop };
}
