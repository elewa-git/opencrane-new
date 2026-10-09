import { ChangeDetectionStrategy, Component, input, signal,
  type OnDestroy, type OnInit, type SimpleChanges } from '@angular/core';

type Scope = { scopeId: string; scopeKind: 'person' | 'group' | 'assistant_notes';
  ownerId: string; audience: { kind: string; ownerId: string }; canRead: boolean };
type Fact = { memoryId: string; revision: number; text: string; kind: 'fact' | 'preference';
  pinned: boolean; expiresAt: string | null; savedAt: string };
type PageFact = Fact | { memoryId: string; revision: number; reason: 'page_limit' };
type Source = { status: 'available' | 'refused' | 'unavailable'; label?: string;
  reference?: { conversationId: string; messageId: string } };
type Page = { scopeId: string; facts: PageFact[]; returnedCount: number;
  nextCursor: string | null };
type Detail = { status: 'unavailable'; scopeId: string; memoryId: string; revision: number | null;
  reason: string } | { scopeId: string; fact: Fact; sources: Source[] };
type DetailRead = { kind: 'ok'; detail: Exclude<Detail, { status: 'unavailable' }> } |
  { kind: 'access' } | { kind: 'missing' } | { kind: 'unavailable' };
type JsonRead = { kind: 'ok'; body: unknown } | { kind: 'access' } | { kind: 'unavailable' };
type ScreenState = 'loading' | 'ready' | 'unavailable' | 'access';

@Component({
  selector: 'oc-memory-panel',
  templateUrl: './memory-panel.html',
  styleUrl: './memory-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown.escape)': 'escapeDetail()' },
})
export class MemoryPanel implements OnInit, OnDestroy {
  readonly groupId = input<string | undefined>();
  readonly assistantId = input<string | undefined>();
  protected readonly scopes = signal<Scope[]>([]);
  protected readonly facts = signal<PageFact[]>([]);
  protected readonly sources = signal<Source[]>([]);
  protected readonly selectedScope = signal('');
  protected readonly selectedFact = signal<Fact | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly listState = signal<'loading' | 'ready' | 'empty' | 'unavailable'>('loading');
  protected readonly query = signal('');
  protected readonly cursor = signal<string | null>(null);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly detailState = signal<'ready' | 'unavailable' | 'missing' | ''>('');
  private generation = 0;
  private listRequestId = 0;
  private detailOpener: HTMLElement | undefined;
  private scopeController: AbortController | undefined;
  private scopeRequestId = 0;

  ngOnInit(): void { void this.loadScopes(); }

  ngOnDestroy(): void {
    this.generation += 1;
    this.scopeRequestId += 1;
    this.scopeController?.abort();
    this.listController?.abort();
    this.detailController?.abort();
    this.scopes.set([]);
    this.facts.set([]);
    this.sources.set([]);
    this.selectedFact.set(undefined);
  }

  ngOnChanges(changes: SimpleChanges): void {
    const groupChanged = changes['groupId']?.firstChange === false;
    const assistantChanged = changes['assistantId']?.firstChange === false;
    if (groupChanged || assistantChanged) void this.loadScopes();
  }
  private listController?: AbortController;
  private detailController?: AbortController;

  protected scopeName(scope: Scope): string {
    if (scope.scopeKind === 'person') return 'Your memory';
    if (scope.scopeKind === 'group') return 'Group memory';
    return 'Assistant notes';
  }

  protected scopeAudience(scope: Scope): string {
    if (scope.audience.kind === 'person') return 'Only you';
    return `Shared with ${scope.audience.kind} ${scope.audience.ownerId}`;
  }

  protected sourceLink(conversationId: string): string {
    return `/workspace?conversation=${encodeURIComponent(conversationId)}`;
  }

  protected async chooseScope(scopeId: string): Promise<void> {
    if (!scopeId || scopeId === this.selectedScope()) return;
    this.generation += 1;
    this.listController?.abort();
    this.detailController?.abort();
    this.selectedFact.set(undefined);
    this.sources.set([]);
    this.detailState.set('');
    this.facts.set([]);
    this.nextCursor.set(null);
    this.selectedScope.set(scopeId);
    this.query.set('');
    this.cursor.set(null);
    await this.loadFacts();
  }

  protected scopeKeydown(event: KeyboardEvent): void {
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

  protected queryChanged(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    this.query.set(input.value);
    this.cursor.set(null);
    void this.loadFacts();
  }

  protected async nextPage(): Promise<void> {
    const next = this.nextCursor();
    if (!next) return;
    this.cursor.set(next);
    await this.loadFacts();
  }

  protected async openFact(fact: Fact, event: Event): Promise<void> {
    const opener = event.currentTarget;
    if (opener instanceof HTMLElement) this.detailOpener = opener;
    this.detailController?.abort();
    const controller = new AbortController();
    const generation = this.generation;
    this.detailController = controller;
    this.selectedFact.set(fact);
    this.sources.set([]);
    this.detailState.set('');
    queueMicrotask(this.focusDetailBack.bind(this));
    const url = detailUrl(this.selectedScope(), fact.memoryId);
    const reply = await readJson(url, controller.signal);
    if (!isCurrentDetailRead(controller, generation, this.generation)) return;
    const result = detailResult(reply);
    if (result.kind === 'access') { this.revoke(); return; }
    if (result.kind === 'missing') { this.detailState.set('missing'); return; }
    if (result.kind === 'unavailable') { this.detailState.set('unavailable'); return; }
    this.selectedFact.set(result.detail.fact);
    this.sources.set(result.detail.sources);
    this.detailState.set('ready');
  }

  protected closeDetail(): void {
    this.detailController?.abort();
    this.selectedFact.set(undefined);
    this.detailState.set('');
    this.detailOpener?.focus();
    this.detailOpener = undefined;
  }

  private focusDetailBack(): void {
    document.getElementById('memory-detail-back')?.focus();
  }

  protected escapeDetail(): void {
    if (this.selectedFact()) this.closeDetail();
  }

  protected detailKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !(event.currentTarget instanceof HTMLElement)) return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private async loadScopes(): Promise<void> {
    this.scopeController?.abort();
    this.generation += 1;
    this.listController?.abort();
    this.detailController?.abort();
    this.selectedScope.set('');
    this.scopes.set([]);
    this.facts.set([]);
    this.selectedFact.set(undefined);
    this.sources.set([]);
    this.state.set('loading');
    this.listState.set('loading');
    const controller = new AbortController();
    this.scopeController = controller;
    this.scopeRequestId += 1;
    const requestId = this.scopeRequestId;
    const url = scopeUrl(this.groupId(), this.assistantId());
    const result = await readJson(url, controller.signal);
    if (!isCurrentScopeRead(controller, requestId, this.scopeRequestId)) return;
    if (result.kind === 'access') { this.revoke(); return; }
    if (result.kind === 'unavailable' || !isScopes(result.body)) {
      this.state.set('unavailable');
      return;
    }
    this.scopes.set(result.body.scopes.filter(canReadScope));
    this.state.set('ready');
    const firstScope = this.scopes()[0];
    if (firstScope) await this.chooseScope(firstScope.scopeId);
    else this.listState.set('empty');
  }

  private async loadFacts(): Promise<void> {
    const scopeId = this.selectedScope();
    if (!scopeId) return;
    this.listController?.abort();
    const controller = new AbortController();
    const generation = this.generation;
    this.listRequestId += 1;
    const requestId = this.listRequestId;
    this.listController = controller;
    this.listState.set('loading');
    const params = new URLSearchParams();
    params.set('q', this.query());
    const cursor = this.cursor();
    if (cursor) params.set('cursor', cursor);
    const url = `/api/memory/${encodeURIComponent(scopeId)}/facts?${params}`;
    const result = await readJson(url, controller.signal);
    if (!isCurrentListRead(controller, generation, this.generation, requestId,
      this.listRequestId)) return;
    if (result.kind === 'access') { this.revoke(); return; }
    if (result.kind === 'unavailable' || !isPage(result.body)) {
      this.listState.set('unavailable');
      return;
    }
    this.facts.set(result.body.facts);
    this.nextCursor.set(result.body.nextCursor);
    this.listState.set(result.body.facts.length ? 'ready' : 'empty');
  }

  private revoke(): void {
    this.generation += 1;
    this.listController?.abort();
    this.detailController?.abort();
    this.scopes.set([]);
    this.facts.set([]);
    this.sources.set([]);
    this.selectedFact.set(undefined);
    this.selectedScope.set('');
    this.query.set('');
    this.cursor.set(null);
    this.nextCursor.set(null);
    this.state.set('access');
  }
}

async function readJson(url: string, signal: AbortSignal): Promise<JsonRead> {
  try {
    const response = await fetch(url, {
      signal, headers: { accept: 'application/json' },
    });
    if (isAccessStatus(response.status)) return { kind: 'access' };
    if (!response.ok) return { kind: 'unavailable' };
    const body: unknown = await response.json();
    return { kind: 'ok', body };
  } catch {
    return { kind: 'unavailable' };
  }
}

function detailResult(reply: JsonRead): DetailRead {
  if (reply.kind === 'access') return { kind: 'access' };
  if (reply.kind === 'unavailable' || !isDetail(reply.body)) {
    return { kind: 'unavailable' };
  }
  if ('status' in reply.body) return { kind: 'missing' };
  return { kind: 'ok', detail: reply.body };
}

function detailUrl(scopeId: string, memoryId: string): string {
  return `/api/memory/${encodeURIComponent(scopeId)}/facts/` +
    encodeURIComponent(memoryId);
}

function isCurrentListRead(controller: AbortController, startedGeneration: number,
  currentGeneration: number, startedRequestId: number, currentRequestId: number): boolean {
  return !controller.signal.aborted && startedGeneration === currentGeneration &&
    startedRequestId === currentRequestId;
}

function isCurrentDetailRead(controller: AbortController, startedGeneration: number,
  currentGeneration: number): boolean {
  return !controller.signal.aborted && startedGeneration === currentGeneration;
}

function isCurrentScopeRead(controller: AbortController, startedRequestId: number,
  currentRequestId: number): boolean {
  return !controller.signal.aborted && startedRequestId === currentRequestId;
}

function scopeUrl(groupId: string | undefined, assistantId: string | undefined): string {
  const params = new URLSearchParams();
  if (groupId) params.set('groupId', groupId);
  if (assistantId) params.set('assistantId', assistantId);
  const query = params.toString();
  if (!query) return '/api/memory/scopes';
  return `/api/memory/scopes?${query}`;
}

function isAccessStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isScopes(value: unknown): value is { scopes: Scope[] } {
  return isObject(value) && Array.isArray(value['scopes']) && value['scopes'].every(isScope);
}

function isScope(value: unknown): value is Scope {
  if (!isObject(value)) return false;
  const audience = value['audience'];
  return typeof value['scopeId'] === 'string' &&
    ['person', 'group', 'assistant_notes'].includes(String(value['scopeKind'])) &&
    typeof value['ownerId'] === 'string' && typeof value['canRead'] === 'boolean' &&
    isObject(audience) &&
    typeof audience['kind'] === 'string' && typeof audience['ownerId'] === 'string';
}

function canReadScope(scope: Scope): boolean { return scope.canRead; }

function isFact(value: unknown): value is Fact {
  return isObject(value) && typeof value['memoryId'] === 'string' &&
    typeof value['text'] === 'string' && typeof value['revision'] === 'number' &&
    (value['kind'] === 'fact' || value['kind'] === 'preference') &&
    typeof value['pinned'] === 'boolean' &&
    (typeof value['expiresAt'] === 'string' || value['expiresAt'] === null) &&
    typeof value['savedAt'] === 'string';
}

function isPage(value: unknown): value is Page {
  return isObject(value) && Array.isArray(value['facts']) && value['facts'].every(isPageFact) &&
    typeof value['returnedCount'] === 'number' &&
    (typeof value['nextCursor'] === 'string' || value['nextCursor'] === null);
}

function isPageFact(value: unknown): value is PageFact {
  if (isFact(value)) return true;
  return isObject(value) && typeof value['memoryId'] === 'string' &&
    typeof value['revision'] === 'number' && value['reason'] === 'page_limit';
}

function isDetail(value: unknown): value is Detail {
  if (!isObject(value)) return false;
  if (value['status'] === 'unavailable') return true;
  return typeof value['scopeId'] === 'string' && isFact(value['fact']) &&
    Array.isArray(value['sources']) && value['sources'].every(isSource);
}

function isSource(value: unknown): value is Source {
  return isObject(value) &&
    ['available', 'refused', 'unavailable'].includes(String(value['status']));
}
