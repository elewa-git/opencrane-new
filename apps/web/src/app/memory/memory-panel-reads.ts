import { isDetail, type Detail, type Scope, type Source } from './memory-panel-data';

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
