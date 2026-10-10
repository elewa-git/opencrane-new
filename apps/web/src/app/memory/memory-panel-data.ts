export type Scope = { scopeId: string; scopeKind: 'person' | 'group' | 'assistant_notes';
  ownerId: string; audience: { kind: string; ownerId: string }; canRead: boolean };
export type Fact = { memoryId: string; revision: number; text: string; kind: 'fact' | 'preference';
  pinned: boolean; expiresAt: string | null; savedAt: string };
export type PageFact = Fact | { memoryId: string; revision: number; reason: 'page_limit' };
export type Source = { status: 'available' | 'refused' | 'unavailable'; label?: string;
  reference?: { conversationId: string; messageId: string } };
export type Page = { scopeId: string; facts: PageFact[]; returnedCount: number;
  nextCursor: string | null };
export type Detail = { status: 'unavailable'; scopeId: string; memoryId: string;
  revision: number | null; reason: string } | { scopeId: string; fact: Fact; sources: Source[] };

type RecordValue = Record<string, unknown>;

export function isObject(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

export function hasRefusedMemoryControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10) return true;
  }
  return false;
}

export function isScopes(value: unknown): value is { scopes: Scope[] } {
  return isObject(value) && Array.isArray(value['scopes']) && value['scopes'].every(isScope);
}

function isScope(value: unknown): value is Scope {
  if (!isObject(value)) return false;
  const audience = value['audience'];
  return typeof value['scopeId'] === 'string' &&
    ['person', 'group', 'assistant_notes'].includes(String(value['scopeKind'])) &&
    typeof value['ownerId'] === 'string' && typeof value['canRead'] === 'boolean' &&
    isObject(audience) && typeof audience['kind'] === 'string' &&
    typeof audience['ownerId'] === 'string';
}

export function canReadScope(scope: Scope): boolean {
  return scope.canRead;
}

function isFact(value: unknown): value is Fact {
  return isObject(value) && typeof value['memoryId'] === 'string' &&
    typeof value['text'] === 'string' && typeof value['revision'] === 'number' &&
    (value['kind'] === 'fact' || value['kind'] === 'preference') &&
    typeof value['pinned'] === 'boolean' &&
    (typeof value['expiresAt'] === 'string' || value['expiresAt'] === null) &&
    typeof value['savedAt'] === 'string';
}

export function isPage(value: unknown): value is Page {
  return isObject(value) && Array.isArray(value['facts']) && value['facts'].every(isPageFact) &&
    typeof value['returnedCount'] === 'number' &&
    (typeof value['nextCursor'] === 'string' || value['nextCursor'] === null);
}

function isPageFact(value: unknown): value is PageFact {
  if (isFact(value)) return true;
  return isObject(value) && typeof value['memoryId'] === 'string' &&
    typeof value['revision'] === 'number' && value['reason'] === 'page_limit';
}

export function isDetail(value: unknown): value is Detail {
  if (!isObject(value)) return false;
  if (value['status'] === 'unavailable') return true;
  return typeof value['scopeId'] === 'string' && isFact(value['fact']) &&
    Array.isArray(value['sources']) && value['sources'].every(isSource);
}

function isSource(value: unknown): value is Source {
  return isObject(value) &&
    ['available', 'refused', 'unavailable'].includes(String(value['status']));
}
