import { isDetail, type Detail, type Scope } from './memory-panel-data';

export type DetailRead = { kind: 'ok'; detail: Exclude<Detail, { status: 'unavailable' }> } |
  { kind: 'access' } | { kind: 'missing' } | { kind: 'unavailable' };
export type JsonRead = { kind: 'ok'; body: unknown } | { kind: 'access' } |
  { kind: 'invalid' } | { kind: 'conflict' } | { kind: 'missing' } | { kind: 'unavailable' };

export async function readJson(url: string, signal: AbortSignal): Promise<JsonRead> {
  try {
    const response = await fetch(url, {
      signal, headers: { accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { kind: 'access' };
    }
    if (response.status === 409) return { kind: 'conflict' };
    if (response.status === 422) return { kind: 'invalid' };
    if (!response.ok) return { kind: 'unavailable' };
    const body: unknown = await response.json();
    return { kind: 'ok', body };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function detailResult(reply: JsonRead): DetailRead {
  if (reply.kind === 'access') return { kind: 'access' };
  if (reply.kind !== 'ok' || !isDetail(reply.body)) {
    return { kind: 'unavailable' };
  }
  if ('status' in reply.body) return { kind: 'missing' };
  return { kind: 'ok', detail: reply.body };
}

export function detailUrl(scopeId: string, memoryId: string): string {
  return `/api/memory/${encodeURIComponent(scopeId)}/facts/` +
    encodeURIComponent(memoryId);
}

export function isCurrentListRead(controller: AbortController, startedGeneration: number,
  currentGeneration: number, startedRequestId: number, currentRequestId: number): boolean {
  return !controller.signal.aborted && startedGeneration === currentGeneration &&
    startedRequestId === currentRequestId;
}

export function isCurrentDetailRead(controller: AbortController, startedGeneration: number,
  currentGeneration: number): boolean {
  return !controller.signal.aborted && startedGeneration === currentGeneration;
}

export function isCurrentScopeRead(controller: AbortController, startedRequestId: number,
  currentRequestId: number): boolean {
  return !controller.signal.aborted && startedRequestId === currentRequestId;
}

export function scopeHasId(scopeId: string, scope: Scope): boolean {
  return scope.scopeId === scopeId;
}
