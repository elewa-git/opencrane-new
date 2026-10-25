import { isObject, isDetail, type Detail, type Scope, type Source } from './memory-panel-data';

export type DetailRead = { kind: 'ok'; detail: Exclude<Detail, { status: 'unavailable' }> } |
  { kind: 'access' } | { kind: 'missing'; reason: string } | { kind: 'unavailable' };
export type JsonRead = { kind: 'ok'; body: unknown } | { kind: 'access' } |
  { kind: 'invalid' } | { kind: 'conflict' } | { kind: 'missing' } | { kind: 'unavailable' };

type ApplyingRead = { kind: 'applying'; retryAfterMs: number };

export async function readJson(url: string, signal: AbortSignal,
  onApplying?: () => void): Promise<JsonRead> {
  const timeout = new AbortController();
  const requestSignal = AbortSignal.any([signal, timeout.signal]);
  function stopReading() {
    timeout.abort();
  }
  const timer = window.setTimeout(stopReading, 30_000);
  let backoffMs = 1000;
  try {
    while (!requestSignal.aborted) {
      const reply = await readOnce(url, requestSignal);
      if (requestSignal.aborted) break;
      if (reply.kind !== 'applying') return reply;
      onApplying?.();
      const delayMs = Math.max(backoffMs, reply.retryAfterMs);
      await waitForPermissions(delayMs, requestSignal);
      backoffMs = Math.min(backoffMs * 2, 5000);
    }
    return { kind: 'unavailable' };
  } finally {
    window.clearTimeout(timer);
  }
}

async function waitForPermissions(delayMs: number, signal: AbortSignal): Promise<void> {
  function wait(resolve: () => void) {
    if (signal.aborted) {
      resolve();
      return;
    }
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    const timer = window.setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  }
  await new Promise<void>(wait);
}

async function readOnce(url: string, signal: AbortSignal): Promise<JsonRead | ApplyingRead> {
  try {
    const response = await fetch(url, {
      signal, headers: { accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { kind: 'access' };
    }
    if (response.status === 409) return { kind: 'conflict' };
    if (response.status === 422) return { kind: 'invalid' };
    if (response.status === 503) {
      const body: unknown = await response.json();
      if (isObject(body) && body['status'] === 'unavailable' &&
          body['reason'] === 'permissions_applying') {
        const seconds = Number(response.headers.get('retry-after'));
        let retryAfterMs = 1000;
        if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = Math.min(seconds * 1000, 30_000);
        return { kind: 'applying', retryAfterMs };
      }
    }
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
  if ('status' in reply.body) return { kind: 'missing', reason: reply.body.reason };
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

export function selectedScopeAudience(scopes: Scope[], scopeId: string): string {
  const scope = scopes.find(scopeHasId.bind(null, scopeId));
  if (!scope) return 'Audience unavailable';
  return scopeAudience(scope);
}

export function waitForRetry(seconds: number, resolve: () => void): void {
  window.setTimeout(resolve, seconds * 1000);
}

export function firstTrustedSource(sources: Source[]): Source['reference'] | undefined {
  for (const source of sources) {
    if (source.status === 'available' && source.reference) return source.reference;
  }
  return undefined;
}

export function sourceMatchesReference(reference: NonNullable<Source['reference']>, source: Source) {
  return source.status === 'available' &&
    source.reference?.conversationId === reference.conversationId &&
    source.reference.messageId === reference.messageId;
}

export function scopeUrl(groupId: string | undefined, assistantId: string | undefined): string {
  const params = new URLSearchParams();
  if (groupId) params.set('groupId', groupId);
  if (assistantId) params.set('assistantId', assistantId);
  const query = params.toString();
  if (!query) return '/api/memory/scopes';
  return `/api/memory/scopes?${query}`;
}

export function scopeName(scope: Scope): string {
  if (scope.scopeKind === 'person') return 'Your memory';
  if (scope.scopeKind === 'group') return 'Group memory';
  return 'Assistant notes';
}

export function scopeAudience(scope: Scope): string {
  if (scope.audience.kind === 'person') return 'Only you';
  return `Shared with ${scope.audience.kind} ${scope.audience.ownerId}`;
}

export function savedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

export function sourceLink(conversationId: string): string {
  return `/workspace?conversation=${encodeURIComponent(conversationId)}`;
}

export function scopeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.scopes button'));
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const currentIndex = buttons.indexOf(target);
  if (currentIndex < 0 || buttons.length === 0) return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const nextIndex = (currentIndex + direction + buttons.length) % buttons.length;
  const nextButton = buttons[nextIndex];
  nextButton?.focus();
  nextButton?.click();
}
