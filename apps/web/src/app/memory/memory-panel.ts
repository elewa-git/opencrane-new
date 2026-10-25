import { ChangeDetectionStrategy, Component, input, signal, viewChild,
  type OnDestroy, type OnInit, type SimpleChanges } from '@angular/core';
import { MemoryEdit } from './memory-edit';
import type { DetailRead } from './memory-panel-reads';
import { Overlay } from '../ui/overlay';
import { canReadScope, isObject, isPage, isScopes,
  type Fact,
  type PageFact, type Scope, type Source } from './memory-panel-data';
import { detailResult, detailUrl, isCurrentDetailRead, isCurrentListRead,
  isCurrentScopeRead, readJson, scopeHasId }
  from './memory-panel-reads';
import { readStoreReply } from './memory-panel-store-reply';
import { storeBytes, storeKindFromEvent, storePayload, storeSourceLabel, storeValidation } from
  './memory-panel-store-input';
import { MemoryForget, type ForgetTarget } from './memory-forget';
import { factIndex, focusAfterForget, withoutForgetTarget, withoutHiddenFactText } from
  './memory-panel-forget';
import { firstTrustedSource, scopeUrl, waitForRetry } from
  './memory-panel-reads';
import { savedDate, scopeAudience, scopeKeydown, scopeName, selectedScopeAudience, sourceLink } from
  './memory-panel-reads';
type ScreenState = 'loading' | 'ready' | 'unavailable' | 'access';
type StoreState = 'editing' | 'saving' | 'saved' | 'failed' | 'busy' | 'unknown';
type StoreCommand = { generation: number; scopeId: string; commandId: string;
  payload: Record<string, unknown> };

@Component({
  selector: 'oc-memory-panel',
  imports: [Overlay, MemoryForget, MemoryEdit],
  templateUrl: './memory-panel.html',
  styleUrl: './memory-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryPanel implements OnInit, OnDestroy {
  protected readonly editor = viewChild(MemoryEdit);
  readonly groupId = input<string | undefined>();
  readonly assistantId = input<string | undefined>();
  readonly requesterId = input<string | undefined>();
  readonly accessDenied = input(false);
  protected readonly scopes = signal<Scope[]>([]);
  protected readonly facts = signal<PageFact[]>([]);
  protected readonly sources = signal<Source[]>([]);
  protected readonly selectedScope = signal('');
  protected readonly selectedFact = signal<Fact | undefined>(undefined);
  protected readonly detailCanCorrect = signal(false);
  protected readonly detailCanForget = signal(false);
  protected readonly forgetTargets = signal<ForgetTarget[]>([]);
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
  private storeCommand: StoreCommand | undefined;

  ngOnInit(): void { void this.loadScopes(); }

  ngOnDestroy(): void { this.revoke(); }

  protected detailLoaded(result: DetailRead, changed = false): void {
    if (result.kind === 'access') { this.revoke(); return; }
    if (result.kind === 'ok') {
      if (changed) {
        this.listController?.abort();
        this.listRequestId += 1;
      }
      const fact = result.detail.fact;
      const index = factIndex(fact.memoryId, this.facts());
      const facts = [...this.facts()];
      if (index >= 0) facts[index] = fact;
      this.facts.set(facts);
      this.selectedFact.set(fact);
      this.sources.set(result.detail.sources);
      this.detailCanCorrect.set(result.detail.canCorrect === true);
      this.detailCanForget.set(result.detail.canForget && this.currentScopeKind() === 'person');
      this.detailState.set('ready');
    } else if (result.kind === 'missing') {
      const fact = this.selectedFact();
      if (fact && ['forgotten', 'quarantined', 'destroyed'].includes(result.reason)) {
        this.hideFactText(fact.memoryId, result.reason);
        this.selectedFact.set({ ...fact, text: '' });
      }
      this.detailCanCorrect.set(false);
      this.detailState.set('missing');
    } else this.detailState.set('unavailable');
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

  protected readonly scopeName = scopeName;
  protected readonly scopeAudience = scopeAudience;
  protected readonly savedDate = savedDate;
  protected readonly sourceLink = sourceLink;
  protected readonly scopeKeydown = scopeKeydown;

  protected selectedScopeAudience(): string {
    return selectedScopeAudience(this.scopes(), this.selectedScope());
  }

  protected async chooseScope(scopeId: string): Promise<void> {
    if (!scopeId || scopeId === this.selectedScope()) return;
    this.generation += 1;
    this.forgetTargets.set([]);
    this.clearStoreState();
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
    this.detailCanCorrect.set(false);
    this.detailCanForget.set(false);
    this.sources.set([]);
    this.detailState.set('');
    const url = detailUrl(this.selectedScope(), fact.memoryId);
    const reply = await readJson(url, controller.signal);
    if (!isCurrentDetailRead(controller, generation, this.generation)) return;
    const result = detailResult(reply);
    this.detailLoaded(result);
  }

  protected closeDetail(): void {
    this.detailController?.abort();
    this.selectedFact.set(undefined);
    this.detailState.set('');
  }

  protected openForget(event: Event): void {
    if (this.editor()?.changePending()) return;
    const fact = this.selectedFact();
    const opener = event.currentTarget;
    if (!fact || !this.detailCanForget() || !(opener instanceof HTMLElement)) return;
    const target = { scopeId: this.selectedScope(), memoryId: fact.memoryId,
      revision: fact.revision, opener };
    this.forgetTargets.set([...this.forgetTargets(), target]);
  }

  protected forgetAccepted(target: ForgetTarget): void {
    if (!this.isCurrentForget(target)) return;
    const index = factIndex(target.memoryId, this.facts());
    const generation = this.generation;
    this.hideFactText(target.memoryId);
    this.closeDetail();
    this.detailOpener = undefined;
    window.setTimeout(this.focusAfterForget.bind(this, index, generation), 0);
  }

  private hideFactText(memoryId: string, reason = 'forgotten'): void {
    // Stop older reads before they can restore text that the server has hidden.
    this.listController?.abort();
    this.listRequestId += 1;
    this.detailController?.abort();
    this.query.set('');
    const remainingFacts = withoutHiddenFactText(memoryId, this.facts(), reason);
    this.facts.set(remainingFacts);
    this.listState.set(remainingFacts.length ? 'ready' : 'empty');
    this.sources.set([]);
    this.detailCanCorrect.set(false);
    this.detailCanForget.set(false);
  }

  private focusAfterForget(index: number, generation: number): void {
    if (generation !== this.generation) return;
    focusAfterForget(index);
  }

  protected reviewLatest(target: ForgetTarget): void {
    if (!this.isCurrentForget(target)) return;
    const fact = this.selectedFact();
    this.closeForget(target);
    if (fact) void this.openFact(fact, new Event('review'));
  }

  protected closeForget(target: ForgetTarget): void {
    if (this.isCurrentForget(target)) {
      this.forgetTargets.set(withoutForgetTarget(target, this.forgetTargets()));
    }
  }

  protected forgetAccessLost(target: ForgetTarget): void {
    if (this.isCurrentForget(target)) this.revoke();
  }

  private isCurrentForget(target: ForgetTarget): boolean {
    return this.forgetTargets().includes(target) && this.selectedScope() === target.scopeId;
  }

  protected openStore(event?: Event): void {
    this.clearStoreState();
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
    if (this.storeState() === 'saving' || this.storeState() === 'unknown') return;
    this.storeOpen.set(false);
    this.storeText.set('');
    this.storeSource.set(undefined);
    this.storeCommandId.set('');
    this.storeCommand = undefined;
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
    const kind = storeKindFromEvent(event);
    if (kind) this.storeKind.set(kind);
  }

  protected storeBytes(): number {
    return storeBytes(this.storeText());
  }

  protected storeInputError(): string {
    if (!this.storeText()) return '';
    return this.storeValidation();
  }

  protected storeValidation(): string {
    return storeValidation(this.storeText(), this.storeKind(), this.currentScopeKind());
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
    const payload = storePayload(commandId, this.storeText(), this.storeKind(), this.storeSource());
    const command: StoreCommand = { generation: this.generation,
      scopeId: this.selectedScope(), commandId, payload };
    this.storeCommand = command;
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(command.scopeId)}/facts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(payload),
      });
      await this.applyStoreReply(response, command);
    } catch {
      if (this.isCurrentStoreCommand(command)) this.storeState.set('unknown');
    }
  }

  private async applyStoreReply(response: Response, command: StoreCommand): Promise<void> {
    if (!this.isCurrentStoreCommand(command)) return;
    const reply = await readStoreReply(response);
    if (!this.isCurrentStoreCommand(command)) return;
    if (reply.kind === 'access') {
      this.revoke();
      return;
    }
    if (reply.kind === 'saved') {
      this.storeState.set('saved');
      return;
    }
    if (reply.kind === 'failed') {
      this.storeState.set('failed');
      this.storeError.set('Nothing was saved. Check the fact and try again.');
      this.storeCommand = undefined;
      return;
    }
    if (reply.kind === 'busy') {
      this.storeRetryAfter.set(reply.retryAfter);
      this.storeState.set('busy');
      return;
    }
    this.storeState.set('unknown');
  }

  protected async retryBusy(): Promise<void> {
    const command = this.storeCommand;
    if (this.storeState() !== 'busy' || !command || !this.isCurrentStoreCommand(command)) return;
    this.storeState.set('saving');
    await new Promise<void>(waitForRetry.bind(null, this.storeRetryAfter()));
    if (!this.isCurrentStoreCommand(command)) return;
    await this.sendSameCommand(command);
  }

  private async sendSameCommand(command: StoreCommand): Promise<void> {
    this.storeState.set('saving');
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(command.scopeId)}/facts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store',
        body: JSON.stringify(command.payload),
      });
      await this.applyStoreReply(response, command);
    } catch {
      if (this.isCurrentStoreCommand(command)) this.storeState.set('unknown');
    }
  }

  protected async checkStoreStatus(): Promise<void> {
    const command = this.storeCommand;
    if (this.storeState() !== 'unknown' || !command || !this.isCurrentStoreCommand(command)) return;
    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(command.scopeId)}` +
        `/changes/${encodeURIComponent(command.commandId)}`, {
        credentials: 'same-origin', cache: 'no-store',
      });
      if (!this.isCurrentStoreCommand(command)) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        this.revoke();
        return;
      }
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!this.isCurrentStoreCommand(command)) return;
      if (isObject(body) && body['outcome'] === 'saved') this.storeState.set('saved');
      else if (isObject(body) && body['outcome'] === 'failed') {
        this.storeState.set('failed');
        this.storeCommand = undefined;
      }
    } catch {
      // Keep an unknown outcome unknown when the status read itself has no reply.
    }
  }

  protected storeSourceLabel(): string {
    return storeSourceLabel(this.storeSource(), this.sources());
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
    this.forgetTargets.set([]);
    this.clearStoreState();
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

  protected revoke(): void {
    this.generation += 1;
    this.forgetTargets.set([]);
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
    this.clearStoreState();
    this.listState.set('empty');
    this.state.set('access');
  }

  private clearStoreState(): void {
    this.storeOpen.set(false);
    this.storeText.set('');
    this.storeKind.set('fact');
    this.storeState.set('editing');
    this.storeError.set('');
    this.storeCommandId.set('');
    this.storeRetryAfter.set(1);
    this.storeSource.set(undefined);
    this.storeCommand = undefined;
    this.storeOpener = undefined;
  }

  private isCurrentStoreCommand(command: StoreCommand): boolean {
    return this.storeCommand === command && command.generation === this.generation &&
      command.scopeId === this.selectedScope();
  }
}
