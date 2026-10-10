import { ChangeDetectionStrategy, Component, input, signal,
  type OnDestroy, type OnInit, type SimpleChanges } from '@angular/core';
import { Overlay } from '../ui/overlay';
import { canReadScope, hasRefusedMemoryControl, isDetail, isObject, isPage, isScopes,
  type Detail, type Fact,
  type PageFact, type Scope, type Source } from './memory-panel-data';
type DetailRead = { kind: 'ok'; detail: Exclude<Detail, { status: 'unavailable' }> } |
  { kind: 'access' } | { kind: 'missing' } | { kind: 'unavailable' };
type JsonRead = { kind: 'ok'; body: unknown } | { kind: 'access' } |
  { kind: 'invalid' } | { kind: 'conflict' } | { kind: 'missing' } | { kind: 'unavailable' };
type ScreenState = 'loading' | 'ready' | 'unavailable' | 'access';
type StoreState = 'editing' | 'saving' | 'saved' | 'failed' | 'busy' | 'unknown';

@Component({
  selector: 'oc-memory-panel',
  imports: [Overlay],
  templateUrl: './memory-panel.html',
  styleUrl: './memory-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryPanel implements OnInit, OnDestroy {
  readonly groupId = input<string | undefined>();
  readonly assistantId = input<string | undefined>();
  readonly requesterId = input<string | undefined>();
  readonly accessDenied = input(false);
  protected readonly scopes = signal<Scope[]>([]);
  protected readonly facts = signal<PageFact[]>([]);
  protected readonly sources = signal<Source[]>([]);
  protected readonly selectedScope = signal('');
  protected readonly selectedFact = signal<Fact | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly listState = signal<
    'loading' | 'ready' | 'empty' | 'unavailable' | 'invalid' | 'conflict'>('loading');
  protected readonly query = signal('');
  protected readonly cursor = signal<string | null>(null);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly detailState = signal<'ready' | 'unavailable' | 'missing' | ''>('');
  protected readonly storeOpen = signal(false);
  protected readonly storeText = signal('');
  protected readonly storeKind = signal<'fact' | 'preference'>('fact');
  protected readonly storeState = signal<StoreState>('editing');
  protected readonly storeError = signal('');
  protected readonly storeCommandId = signal('');
  protected readonly storeRetryAfter = signal(1);
  protected readonly storeSource = signal<Source['reference'] | undefined>(undefined);
  protected storeOpener: HTMLElement | undefined;
  private generation = 0;
  private listRequestId = 0;
  protected detailOpener: HTMLElement | undefined;
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
    this.selectedScope.set('');
    this.selectedFact.set(undefined);
    this.detailOpener = undefined;
    this.query.set('');
    this.cursor.set(null);
    this.nextCursor.set(null);
    this.detailState.set('');
    this.storeOpen.set(false);
    this.storeText.set('');
    this.storeSource.set(undefined);
  }

  ngOnChanges(changes: SimpleChanges): void {
    const groupChanged = changes['groupId']?.firstChange === false;
    const assistantChanged = changes['assistantId']?.firstChange === false;
    const requesterChanged = changes['requesterId']?.firstChange === false;
    const accessChange = changes['accessDenied'];
    const accessWasRevoked = accessChange?.currentValue === true;
    const accessWasRestored = accessChange?.firstChange === false &&
      accessChange.currentValue === false;
    if (accessWasRevoked) this.revoke();
    else if (accessWasRestored || groupChanged || assistantChanged || requesterChanged) {
      void this.loadScopes();
    }
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

  protected selectedScopeAudience(): string {
    const selectedScopeId = this.selectedScope();
    const scope = this.scopes().find(this.isSelectedScope.bind(null, selectedScopeId));
    if (!scope) return 'Audience unavailable';
    return this.scopeAudience(scope);
  }

  private isSelectedScope(selectedScopeId: string, scope: Scope): boolean {
    return scope.scopeId === selectedScopeId;
  }

  protected savedDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' })
      .format(date);
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
    const url = detailUrl(this.selectedScope(), fact.memoryId);
    const reply = await readJson(url, controller.signal);
    if (!isCurrentDetailRead(controller, generation, this.generation)) return;
    const result = detailResult(reply);
    if (result.kind === 'access') { this.revoke(); return; }
    if (result.kind === 'missing') { this.detailState.set('missing'); return; }
    if (result.kind !== 'ok') { this.detailState.set('unavailable'); return; }
    this.selectedFact.set(result.detail.fact);
    this.sources.set(result.detail.sources);
    this.detailState.set('ready');
  }

  protected closeDetail(): void {
    this.detailController?.abort();
    this.selectedFact.set(undefined);
    this.detailState.set('');
  }

  protected openStore(event?: Event): void {
    if (event?.currentTarget instanceof HTMLElement) {
      this.storeOpener = event.currentTarget;
    }
    this.storeOpen.set(true);
    this.storeState.set('editing');
    this.storeError.set('');
    this.storeText.set('');
    this.storeKind.set('fact');
    this.storeSource.set(firstTrustedSource(this.sources()));
  }

  protected cancelStore(): void {
    if (this.storeState() === 'saving') return;
    this.storeOpen.set(false);
    this.storeText.set('');
    this.storeSource.set(undefined);
    this.storeCommandId.set('');
  }

  protected storeOverlayClosed(): void {
    this.cancelStore();
    this.storeOpener = undefined;
  }

  protected retryFailedFact(): void {
    this.storeState.set('editing');
    this.storeError.set('');
  }

  protected storeTextChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    this.storeText.set(target.value);
    this.storeError.set('');
  }

  protected storeKindChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    this.storeKind.set(target.value === 'preference' ? 'preference' : 'fact');
  }

  protected storeBytes(): number {
    return new TextEncoder().encode(this.storeText()).byteLength;
  }

  protected storeValidation(): string {
    const text = this.storeText();
    const bytes = this.storeBytes();
    if (bytes < 1 || bytes > 4096) return 'Facts must be 1 to 4,096 UTF-8 bytes.';
    if (hasRefusedMemoryControl(text) || new TextDecoder('utf-8', { ignoreBOM: true })
      .decode(new TextEncoder().encode(text)) !== text) {
      return 'Remove unsupported control characters and try again.';
    }
    if (this.storeKind() === 'preference' && this.currentScopeKind() !== 'person') {
      return 'Preferences can only be saved in your memory.';
    }
    return '';
  }

  protected currentScopeKind(): Scope['scopeKind'] | undefined {
    const selected = this.selectedScope();
    const scope = this.scopes().find(scopeHasId.bind(null, selected));
    return scope?.scopeKind;
  }

  protected async saveFact(): Promise<void> {
    const validation = this.storeValidation();
    if (validation) {
      this.storeError.set(validation);
      return;
    }
    const commandId = `mem_${crypto.randomUUID()}`;
    this.storeCommandId.set(commandId);
    this.storeState.set('saving');
    this.storeError.set('');
    const payload = this.storePayload(commandId);
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(this.selectedScope())}/facts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(payload),
      });
      await this.readStoreReply(response);
    } catch {
      this.storeState.set('unknown');
    }
  }

  private storePayload(commandId: string): Record<string, unknown> {
    const source = this.storeSource();
    const sources = source ? [source] : [];
    return { commandId, text: this.storeText(), kind: this.storeKind(), pinned: false,
      expiresAt: null, sources, dependsOn: [] };
  }

  private async readStoreReply(response: Response): Promise<void> {
    if (response.status === 200) {
      const body: unknown = await response.json();
      this.storeState.set(isObject(body) && body['outcome'] === 'saved' ? 'saved' : 'unknown');
      return;
    }
    if (response.status === 422 || response.status === 409 || response.status === 404) {
      this.storeState.set('failed');
      this.storeError.set('Nothing was saved. Check the fact and try again.');
      return;
    }
    if (response.status === 503) {
      const body: unknown = await response.json();
      if (isObject(body) && body['reason'] === 'memory_busy') {
        const seconds = Number(response.headers.get('retry-after'));
        this.storeRetryAfter.set(Number.isFinite(seconds) && seconds > 0 ? seconds : 1);
        this.storeState.set('busy');
        return;
      }
    }
    this.storeState.set('unknown');
  }

  protected async retryBusy(): Promise<void> {
    if (this.storeState() !== 'busy') return;
    this.storeState.set('saving');
    await new Promise<void>(waitForRetry.bind(null, this.storeRetryAfter()));
    await this.sendSameCommand();
  }

  private async sendSameCommand(): Promise<void> {
    this.storeState.set('saving');
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(this.selectedScope())}/facts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store',
        body: JSON.stringify(this.storePayload(this.storeCommandId())),
      });
      await this.readStoreReply(response);
    } catch {
      this.storeState.set('unknown');
    }
  }

  protected async checkStoreStatus(): Promise<void> {
    if (this.storeState() !== 'unknown') return;
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(this.selectedScope())}` +
        `/changes/${encodeURIComponent(this.storeCommandId())}`, {
        credentials: 'same-origin', cache: 'no-store',
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (isObject(body) && body['outcome'] === 'saved') this.storeState.set('saved');
      else if (isObject(body) && body['outcome'] === 'failed') this.storeState.set('failed');
    } catch {
      // Keep an unknown outcome unknown when the status read itself has no reply.
    }
  }

  protected storeSourceLabel(): string {
    const selected = this.storeSource();
    if (!selected) return 'Your statement';
    const source = this.sources().find(sourceMatchesReference.bind(null, selected));
    return source?.label || 'Available source';
  }

  protected detailOverlayClosed(): void {
    if (this.selectedFact()) {
      this.detailController?.abort();
      this.selectedFact.set(undefined);
      this.detailState.set('');
    }
    this.detailOpener = undefined;
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
    this.detailOpener = undefined;
    this.query.set('');
    this.cursor.set(null);
    this.nextCursor.set(null);
    this.detailState.set('');
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
    if (result.kind !== 'ok' || !isScopes(result.body)) {
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
    if (result.kind === 'invalid') {
      this.facts.set([]);
      this.listState.set('invalid');
      this.cursor.set(null);
      this.nextCursor.set(null);
      return;
    }
    if (result.kind === 'conflict') {
      const hadCursor = this.cursor() !== null;
      this.cursor.set(null);
      this.nextCursor.set(null);
      if (hadCursor) await this.loadFacts();
      else this.listState.set('conflict');
      return;
    }
    if (result.kind !== 'ok' || !isPage(result.body)) {
      this.listState.set('unavailable');
      return;
    }
    this.facts.set(result.body.facts);
    this.nextCursor.set(result.body.nextCursor);
    this.listState.set(result.body.facts.length ? 'ready' : 'empty');
  }

  private revoke(): void {
    this.generation += 1;
    this.scopeRequestId += 1;
    this.scopeController?.abort();
    this.listController?.abort();
    this.detailController?.abort();
    this.scopes.set([]);
    this.facts.set([]);
    this.sources.set([]);
    this.selectedFact.set(undefined);
    this.detailOpener = undefined;
    this.selectedScope.set('');
    this.query.set('');
    this.cursor.set(null);
    this.nextCursor.set(null);
    this.detailState.set('');
    this.listState.set('empty');
    this.state.set('access');
  }
}

async function readJson(url: string, signal: AbortSignal): Promise<JsonRead> {
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

function detailResult(reply: JsonRead): DetailRead {
  if (reply.kind === 'access') return { kind: 'access' };
  if (reply.kind !== 'ok' || !isDetail(reply.body)) {
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

function scopeHasId(scopeId: string, scope: Scope): boolean {
  return scope.scopeId === scopeId;
}

function waitForRetry(seconds: number, resolve: () => void): void {
  window.setTimeout(resolve, seconds * 1000);
}

function firstTrustedSource(sources: Source[]): Source['reference'] | undefined {
  for (const source of sources) {
    if (source.status === 'available' && source.reference) return source.reference;
  }
  return undefined;
}

function sourceMatchesReference(reference: NonNullable<Source['reference']>, source: Source) {
  return source.status === 'available' &&
    source.reference?.conversationId === reference.conversationId &&
    source.reference.messageId === reference.messageId;
}

function scopeUrl(groupId: string | undefined, assistantId: string | undefined): string {
  const params = new URLSearchParams();
  if (groupId) params.set('groupId', groupId);
  if (assistantId) params.set('assistantId', assistantId);
  const query = params.toString();
  if (!query) return '/api/memory/scopes';
  return `/api/memory/scopes?${query}`;
}
