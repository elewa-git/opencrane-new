import { ChangeDetectionStrategy, Component, input, output, signal, type OnDestroy } from
  '@angular/core';
import { DatePipe } from '@angular/common';
import { ModalSheet } from '../ui/modal-sheet';
import { isObject, type Fact } from './memory-panel-data';
import { detailResult, detailUrl, readJson, waitForRetry, type DetailRead } from './memory-panel-reads';
import { storeValidation } from './memory-panel-store-input';

type State = 'closed' | 'editing' | 'sending' | 'unknown' | 'conflict' | 'reading' |
  'accepted' | 'missing';
type Receipt = { revision: number; acceptedAt: string; cleanupStatus: string };

@Component({
  selector: 'oc-memory-edit',
  imports: [ModalSheet, DatePipe],
  templateUrl: './memory-edit.html',
  styleUrl: './memory-edit.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.--oc-sheet-height]': 'viewportHeight()' },
})
export class MemoryEdit implements OnDestroy {
  readonly fact = input.required<Fact>();
  readonly scopeId = input.required<string>();
  readonly enabled = input(false);
  readonly refreshed = output<DetailRead>();
  readonly accessLost = output<void>();
  protected readonly state = signal<State>('closed');
  protected readonly draft = signal('');
  protected readonly error = signal('');
  protected readonly receipt = signal<Receipt | undefined>(undefined);
  protected readonly refreshing = signal(false);
  protected readonly awaitingRevision = signal(false);
  protected readonly missingReason = signal('');
  protected opener: HTMLElement | undefined;
  protected revision: Fact | undefined;
  private commandId = '';
  private alive = true;
  private refreshController: AbortController | undefined;
  private readonly viewport = window.visualViewport;
  protected readonly viewportHeight = signal(`${this.viewport?.height ?? window.innerHeight}px`);
  private readonly resized = this.resizeViewport.bind(this);

  constructor() { this.viewport?.addEventListener('resize', this.resized); }

  ngOnDestroy(): void {
    this.alive = false;
    this.refreshController?.abort();
    this.draft.set('');
    this.revision = undefined;
    this.viewport?.removeEventListener('resize', this.resized);
  }

  private resizeViewport(): void {
    // Keep phone actions above the on-screen keyboard.
    this.viewportHeight.set(`${this.viewport?.height ?? window.innerHeight}px`);
  }

  protected open(event: Event): void {
    if (this.refreshing() || this.awaitingRevision() || !this.enabled()) return;
    if (this.state() !== 'closed' && this.state() !== 'accepted') return;
    if (event.currentTarget instanceof HTMLElement) this.opener = event.currentTarget;
    this.revision = this.fact();
    this.draft.set(this.revision.text);
    this.error.set('');
    this.receipt.set(undefined);
    this.state.set('editing');
  }

  protected cancel(): void {
    if (!['editing', 'conflict', 'missing'].includes(this.state())) return;
    this.draft.set('');
    this.state.set('closed');
  }

  protected validation(): string {
    return storeValidation(this.draft(), this.fact().kind, 'person');
  }

  protected textChanged(event: Event): void {
    if (event.target instanceof HTMLTextAreaElement) this.draft.set(event.target.value);
  }

  protected async save(): Promise<void> {
    if (this.state() !== 'editing' || this.validation() || !this.revision) return;
    const fact = this.revision;
    this.commandId = `mem_${crypto.randomUUID()}`;
    const payload = {
      commandId: this.commandId, expectedRevision: fact.revision, text: this.draft(),
      kind: fact.kind, pinned: fact.pinned, expiresAt: fact.expiresAt,
    };
    const body = JSON.stringify(payload);
    await this.send(`${detailUrl(this.scopeId(), fact.memoryId)}/correct`, body);
  }

  protected async checkStatus(): Promise<void> {
    if (this.state() !== 'unknown') return;
    const url = `/api/memory/${encodeURIComponent(this.scopeId())}/changes/` + this.commandId;
    await this.send(url);
  }

  private async send(url: string, body?: string): Promise<void> {
    this.state.set('sending');
    const options: RequestInit = { credentials: 'same-origin', cache: 'no-store' };
    if (body) {
      options.method = 'POST';
      options.headers = { 'content-type': 'application/json' };
      options.body = body;
    }
    try {
      const response = await fetch(url, options);
      if (!this.alive) return;
      if ([401, 403, 404].includes(response.status)) {
        this.accessLost.emit();
        return;
      }
      if (response.status === 409) {
        this.state.set('conflict');
        return;
      }
      if (response.status === 422) {
        this.error.set('Nothing was saved');
        this.state.set('editing');
        return;
      }
      if (!response.ok) {
        this.state.set('unknown');
        return;
      }
      const result: unknown = await response.json();
      if (this.alive) await this.applyBody(result);
    } catch {
      if (this.alive && !this.receipt()) this.state.set('unknown');
    }
  }

  private async applyBody(body: unknown): Promise<void> {
    // Keep an accepted result when an older reply arrives later.
    if (this.receipt()) return;
    if (isObject(body) && body['outcome'] === 'conflict') {
      this.state.set('conflict');
      return;
    }
    if (!isObject(body) || body['operation'] !== 'correct' || body['outcome'] !== 'accepted' ||
      body['memoryId'] !== this.fact().memoryId || body['scopeId'] !== this.scopeId() ||
      typeof body['revision'] !== 'number' || typeof body['acceptedAt'] !== 'string' ||
      !['pending', 'completed', 'unavailable'].includes(String(body['cleanupStatus']))) {
      this.state.set('unknown');
      return;
    }
    const receipt: Receipt = {
      revision: body['revision'], acceptedAt: body['acceptedAt'],
      cleanupStatus: String(body['cleanupStatus']),
    };
    this.receipt.set(receipt);
    this.awaitingRevision.set(true);
    this.draft.set('');
    this.revision = undefined;
    this.state.set('accepted');
    await this.refresh();
  }

  protected async refresh(): Promise<void> {
    if (this.refreshing()) return;
    if (this.state() !== 'conflict' && this.state() !== 'accepted') return;
    const accepted = this.state() === 'accepted';
    if (!accepted) this.state.set('reading');
    const url = detailUrl(this.scopeId(), this.fact().memoryId);
    const controller = new AbortController();
    this.refreshController = controller;
    this.refreshing.set(true);
    this.error.set('');
    const abort = controller.abort.bind(controller);
    const timeout = window.setTimeout(abort, 5000);
    const result = await this.readRevision(url, controller.signal);
    window.clearTimeout(timeout);
    if (!this.alive) return;
    this.refreshing.set(false);
    if (result.kind === 'access') {
      this.accessLost.emit();
      return;
    }
    if (result.kind === 'unavailable') {
      this.error.set('Details are unavailable right now. Try refreshing again.');
      if (!accepted) this.state.set('conflict');
      return;
    }
    this.awaitingRevision.set(false);
    if (result.kind === 'missing') {
      this.missingReason.set(result.reason);
      this.draft.set('');
      this.revision = undefined;
      this.state.set('missing');
    } else if (!accepted) {
      if (result.kind === 'ok' && result.detail.canCorrect === true) {
        this.revision = result.detail.fact;
        this.state.set('editing');
      } else {
        this.state.set('conflict');
      }
    }
    this.refreshed.emit(result);
  }

  private async readRevision(url: string, signal: AbortSignal): Promise<DetailRead> {
    const savedRevision = this.receipt()?.revision;
    while (!signal.aborted) {
      const reply = await readJson(url, signal);
      if (signal.aborted) break;
      const result = detailResult(reply);
      if (savedRevision === undefined || result.kind === 'access' || result.kind === 'missing') {
        return result;
      }
      if (result.kind === 'ok' && result.detail.fact.revision >= savedRevision) return result;
      // Wait for the saved revision without repeating the correction or replacing current controls.
      await new Promise<void>(waitForRetry.bind(null, 0.25));
    }
    return { kind: 'unavailable' };
  }
}
