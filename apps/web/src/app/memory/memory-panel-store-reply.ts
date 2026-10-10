export type StoreReply = { kind: 'access' } | { kind: 'saved' } | { kind: 'failed' } |
  { kind: 'busy'; retryAfter: number } | { kind: 'unknown' };

export async function readStoreReply(response: Response): Promise<StoreReply> {
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { kind: 'access' };
  }
  if (response.status === 200) {
    const body: unknown = await response.json();
    if (isSavedReply(body)) return { kind: 'saved' };
    return { kind: 'unknown' };
  }
  if (response.status === 422 || response.status === 409) return { kind: 'failed' };
  if (response.status === 503) return readBusyReply(response);
  return { kind: 'unknown' };
}

function readBusyReply(response: Response): Promise<StoreReply> {
  return response.json().then(readBusyBody.bind(null, response));
}

function readBusyBody(response: Response, body: unknown): StoreReply {
  if (!isBusyReply(body)) return { kind: 'unknown' };
  const seconds = Number(response.headers.get('retry-after'));
  const retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
  return { kind: 'busy', retryAfter };
}

function isSavedReply(body: unknown): boolean {
  return isRecord(body) && body['outcome'] === 'saved';
}

function isBusyReply(body: unknown): boolean {
  return isRecord(body) && body['reason'] === 'memory_busy';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
