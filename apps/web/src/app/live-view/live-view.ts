import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { ChangeDetectionStrategy, Component, ElementRef, input, output, signal, viewChild, type OnDestroy, type OnChanges, type SimpleChanges } from '@angular/core';
import type RFB from '@novnc/novnc/lib/rfb.js';

@Component({
  selector: 'oc-live-view', imports: [SharedState], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button class="entry" type="button" (click)="watch()">Watch your computer</button>
    <dialog #dialog aria-label="Computer view" (close)="close('Disconnected')"><section aria-label="Computer view"><header><div><h2>Computer</h2><span>Read-only · shared desktop</span></div>
    <button type="button" (click)="dialog.close()">Close view</button></header>
    @if (state() === 'Not available') { <p>A conversation participant needs a shared-desktop grant and a ready computer to watch. Ask the desktop owner for access.</p> }
    <div role="status" aria-live="polite">
      <oc-shared-state [kind]="viewState()" [message]="state()"
        [evidenceAt]="viewedAt()" [showAction]="false" />
      @if (captureStatus()) {
        <oc-shared-state [kind]="captureKind()" [message]="captureStatus()"
          [evidenceAt]="capturedAt()" [showAction]="false" />
      }
    </div>
    @if (state() === 'Access changed') { <p>Ask the desktop owner for access, or sign in again.</p> }
    <div [attr.aria-busy]="state() === 'Connecting' || capturing()" class="display" #display tabindex="0" aria-label="Read-only computer display" [hidden]="state() !== 'Viewing'"></div>
    @if (state() === 'Viewing') { <div class="tools"><button type="button" [disabled]="capturing()" (click)="capture()">Screenshot</button><button type="button" [attr.aria-pressed]="fit()" (click)="zoom(true)">Fit</button>
      <button type="button" [attr.aria-pressed]="!fit()" (click)="zoom(false)">Actual size · zoom</button></div> }
    </section></dialog>`,
  styles: `:host{display:block;min-width:0}.entry{margin:12px 18px;width:calc(100% - 36px);text-align:left}
    dialog{width:min(1000px,94vw);max-height:90dvh;padding:0;border:0;border-radius:12px;color:#12343b}dialog::backdrop{background:#16191a55}section{border:1px solid var(--border,#d9dfe0);border-radius:12px;padding:16px;background:#fbfcfc}
    header,.tools{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h2{margin:0 0 4px;font-size:18px}
    p,span{font-size:14px}button{min-height:44px;min-width:44px;padding:8px 16px;border:1px solid #6d8388;border-radius:6px;background:#fff;color:#12343b;font:inherit;cursor:pointer}
    button:focus-visible,.display:focus-visible{outline:2px solid #0a8497;outline-offset:2px}.display{height:min(60vh,600px);width:100%;overflow:auto;background:#172a2d}
    .display[hidden]{display:none}.tools{justify-content:flex-start;margin-top:12px}@media(max-width:500px){header>button{width:100%}section{padding:12px}.display{height:300px}}`,
})
export class LiveView implements OnDestroy, OnChanges {
  readonly conversationId = input.required<string>();
  readonly saved = output<void>();
  protected readonly capturing = signal(false);
  protected readonly captureStatus = signal('');
  protected readonly captureKind = signal<PresentationState>('checking');
  protected readonly capturedAt = signal<string | undefined>(undefined);
  protected readonly viewedAt = signal<string | undefined>(undefined);
  private captureKey = '';
  private captureAbort: AbortController | undefined;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly display = viewChild.required<ElementRef<HTMLElement>>('display');
  protected readonly state = signal('Disconnected');
  protected readonly fit = signal(true);
  private viewer: RFB | undefined;
  private socket: WebSocket | undefined;
  private attempt = 0;
  protected viewState(): PresentationState {
    if (this.state() === 'Connecting') return 'checking';
    if (this.state() === 'Viewing') return 'ready';
    if (this.state() === 'Access changed' || this.state() === 'Not available') {
      return 'access_changed';
    }
    return 'paused';
  }
  protected watch(): void { this.dialog().nativeElement.showModal(); void this.open(); }
  protected zoom(fit: boolean): void { this.fit.set(fit); if (this.viewer) this.viewer.scaleViewport = fit; }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['conversationId'] && !changes['conversationId'].firstChange) { this.dialog().nativeElement.close(); this.close('Disconnected'); this.captureKey = ''; this.captureStatus.set(''); }
  }
  ngOnDestroy(): void { this.close('Disconnected'); }
  protected close(state: string): void {
    this.captureAbort?.abort(); this.capturing.set(false);
    this.captureStatus.set('');
    this.attempt++; this.viewer?.disconnect(); this.socket?.close();
    this.viewer = undefined; this.socket = undefined; this.display().nativeElement.replaceChildren(); this.state.set(state);
    this.viewedAt.set(undefined);
  }
  protected async capture(): Promise<void> {
    if (this.capturing() || this.state() !== 'Viewing') return;
    const attempt = this.attempt;
    this.captureKey ||= crypto.randomUUID();
    this.captureKind.set('checking');
    this.capturedAt.set(undefined);
    this.captureAbort = new AbortController(); this.capturing.set(true); this.captureStatus.set('Capturing and scanning…');
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(this.conversationId())}/screenshots`, {
        method: 'POST', headers: { 'x-opencrane-view': '1', 'idempotency-key': this.captureKey },
        signal: AbortSignal.any([this.captureAbort.signal, AbortSignal.timeout(90_000)]),
      });
      if (attempt !== this.attempt) return;
      if (response.status === 422) this.captureKey = '';
      await captureReply(response);
      if (attempt !== this.attempt) return;
      this.captureKind.set('confirmed');
      this.capturedAt.set(new Date().toISOString());
      this.captureKey = ''; this.captureStatus.set('Screenshot saved'); this.saved.emit();
    } catch (error) {
      // A closed or replaced view must not change the current capture's state.
      if (attempt !== this.attempt) return;
      if (error instanceof CaptureRejection) {
        this.captureKind.set(error.kind);
        this.captureStatus.set(error.message);
      } else {
        this.captureKind.set('unknown');
        this.captureStatus.set('Screenshot outcome unknown. Check the session files before continuing.');
      }
    } finally { if (attempt === this.attempt) this.capturing.set(false); }
  }
  private async open(): Promise<void> {
    const attempt = ++this.attempt; this.state.set('Connecting');
    try {
      const url = `/api/conversations/${encodeURIComponent(this.conversationId())}/view`;
      const response = await fetch(url, { method: 'POST', headers: { 'x-opencrane-view': '1' } });
      if (attempt !== this.attempt) return;
      if (response.status === 401 || response.status === 403) return this.close('Not available');
      if (!response.ok) throw new Error('View unavailable');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('ticket' in result) || typeof result.ticket !== 'string') throw new Error('View unavailable');
      const { default: Rfb } = await import('./viewer');
      if (attempt !== this.attempt) return;
      const address = new URL(`/ws/conversations/${encodeURIComponent(this.conversationId())}/view`, location.href); address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(address, ['binary', result.ticket]); this.socket = socket;
      const onSocketClose = this.socketClosed.bind(this, attempt);
      socket.addEventListener('close', onSocketClose);
      const viewer = new Rfb(this.display().nativeElement, socket);
      this.viewer = viewer;
      viewer.viewOnly = true;
      viewer.scaleViewport = this.fit();
      viewer.resizeSession = false;
      viewer.focusOnClick = false;
      const onConnected = this.connected.bind(this, attempt);
      const onDisconnected = this.disconnected.bind(this, attempt);
      viewer.addEventListener('connect', onConnected);
      viewer.addEventListener('disconnect', onDisconnected);
    } catch { if (attempt === this.attempt) this.close('Disconnected'); }
  }
  private socketClosed(attempt: number, event: CloseEvent): void {
    if (attempt !== this.attempt) return;
    const state = event.code === 4003 ? 'Access changed' : 'Disconnected';
    this.close(state);
  }

  private connected(attempt: number): void {
    if (attempt !== this.attempt) return;
    this.state.set('Viewing');
    this.viewedAt.set(new Date().toISOString());
  }

  private disconnected(attempt: number): void {
    if (attempt === this.attempt) this.close('Disconnected');
  }

}

class CaptureRejection extends Error {
  readonly kind: PresentationState;

  constructor(status: number) {
    super('Screenshot could not be saved. The server rejected the capture.');
    this.kind = status === 401 || status === 403 || status === 422 ? 'refused' : 'failed';
  }
}

async function captureReply(response: Response): Promise<void> {
  if (!response.ok) {
    const rejection = new CaptureRejection(response.status);
    try {
      const result: unknown = await response.json();
      if (result && typeof result === 'object' && 'error' in result
        && typeof result.error === 'string') {
        rejection.message = result.error;
      }
    } catch {
      // The rejection is definite even when its detail cannot be read.
      throw rejection;
    }
    throw rejection;
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('status' in result)
    || result.status !== 'appended') {
    throw new Error('Capture outcome missing');
  }
}
