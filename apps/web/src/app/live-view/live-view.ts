import { ModalSheet } from '../ui/modal-sheet';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  InjectionToken,
  input,
  output,
  signal,
  viewChild,
  type OnDestroy,
  type OnChanges,
  type SimpleChanges,
} from '@angular/core';
import { LeaseChannel, type LeaseNotice } from './lease-channel';
import type RFB from '@novnc/novnc/lib/rfb.js';

type ViewerConstructor = typeof RFB;
async function loadViewer(): Promise<ViewerConstructor> {
  const viewer = await import('./viewer');
  return viewer.default;
}
function viewerFactory() {
  return loadViewer;
}
const viewerProvider = { factory: viewerFactory };
export const LIVE_VIEWER = new InjectionToken<() => Promise<ViewerConstructor>>(
  'live viewer', viewerProvider,
);
function stateForCloseCode(code: number) {
  if (code === 4003) return 'Access changed';
  if (code === 4503) return 'Failed';
  return 'Disconnected';
}

@Component({
  selector: 'oc-live-view',
  imports: [SharedState, ModalSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-view.html',
  styleUrl: './live-view.css',
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
  protected readonly viewOpen = signal(false);
  private readonly display = viewChild.required<ElementRef<HTMLElement>>('display');
  protected readonly state = signal('Disconnected');
  protected readonly fit = signal(true);
  private readonly loadViewer = inject(LIVE_VIEWER);
  private viewer: RFB | undefined;
  private socket: WebSocket | undefined;
  private attempt = 0;
  private channel: LeaseChannel | undefined;
  private viewerConstructor: ViewerConstructor | undefined;
  private viewerToken = 0;
  private connected = false;
  private viewerConnected = false;
  private serverPaused = true;
  private locallyExpired = true;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseDeadline = -Infinity;
  protected readonly accessConfirmed = signal(false);

  protected connectionDetail() {
    if (this.accessConfirmed()) return 'Access confirmed. Starting the desktop…';
    return 'Checking your access…';
  }
  protected viewState(): PresentationState {
    if (this.state() === 'Connecting') return 'checking';
    if (this.state() === 'Viewing') return 'ready';
    if (this.state() === 'Failed') return 'failed';
    if (this.state() === 'Unavailable') return 'refused';
    if (this.state() === 'Access changed') {
      return 'access_changed';
    }
    return 'paused';
  }
  protected watch(): void {
    this.viewOpen.set(true);
    void this.open();
  }
  protected panelClosed(): void {
    this.viewOpen.set(false);
    this.close('Disconnected');
  }
  protected retry(): void {
    void this.open();
  }
  protected zoom(fit: boolean): void { this.fit.set(fit); if (this.viewer) this.viewer.scaleViewport = fit; }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['conversationId'] && !changes['conversationId'].firstChange) {
      this.panelClosed();
      this.captureKey = '';
      this.captureStatus.set('');
    }
  }
  ngOnDestroy(): void { this.close('Disconnected'); }
  protected close(state: string): void {
    this.captureAbort?.abort();
    this.capturing.set(false);
    this.captureStatus.set('');
    this.attempt++;
    clearTimeout(this.leaseTimer);
    this.clearPicture();
    this.socket?.close();
    this.socket = undefined;
    this.channel = undefined;
    this.connected = false;
    this.accessConfirmed.set(false);
    this.serverPaused = true;
    this.locallyExpired = true;
    this.state.set(state);
    this.viewedAt.set(undefined);
  }

  private clearPicture() {
    // Disconnect events from the old viewer must not close its replacement or the session.
    this.viewerToken++;
    const viewer = this.viewer;
    this.viewer = undefined;
    this.viewerConnected = false;
    viewer?.disconnect();
    this.channel?.detachViewer();
    this.display().nativeElement.replaceChildren();
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
    const attempt = ++this.attempt;
    this.state.set('Connecting');
    try {
      const url = `/api/conversations/${encodeURIComponent(this.conversationId())}/view`;
      const response = await fetch(url, { method: 'POST', headers: { 'x-opencrane-view': '1' } });
      if (attempt !== this.attempt) return;
      if (response.status === 401 || response.status === 403) return this.close('Unavailable');
      if (response.status === 503) return this.close('Failed');
      if (!response.ok) throw new Error('View unavailable');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('ticket' in result)
        || typeof result.ticket !== 'string') {
        throw new Error('View unavailable');
      }
      this.viewerConstructor = await this.loadViewer();
      if (attempt !== this.attempt) return;
      const path = `/ws/conversations/${encodeURIComponent(this.conversationId())}/view`;
      const address = new URL(path, location.href);
      address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(address, ['binary', result.ticket]);
      this.socket = socket;
      const onSocketClose = this.socketClosed.bind(this, attempt);
      socket.addEventListener('close', onSocketClose);
      function notice(this: LiveView, lease: LeaseNotice) {
        if (attempt === this.attempt) this.onLeaseNotice(attempt, lease);
      }
      function invalid(this: LiveView) {
        if (attempt === this.attempt) this.close('Disconnected');
      }
      const onNotice = notice.bind(this);
      const onInvalid = invalid.bind(this);
      const events = { notice: onNotice, invalid: onInvalid };
      this.channel = new LeaseChannel(socket, events);
      this.startViewer(attempt);
    } catch {
      if (attempt === this.attempt) this.close('Disconnected');
    }
  }

  private startViewer(attempt: number) {
    const channel = this.channel;
    const Rfb = this.viewerConstructor;
    if (!channel || !Rfb || attempt !== this.attempt) return;
    const token = ++this.viewerToken;
    const port = channel.attachViewer();
    const viewer = new Rfb(this.display().nativeElement, port);
    this.viewer = viewer;
    this.viewerConnected = false;
    viewer.viewOnly = true;
    viewer.scaleViewport = this.fit();
    viewer.resizeSession = false;
    viewer.focusOnClick = false;
    function connected(this: LiveView) {
      if (attempt !== this.attempt || token !== this.viewerToken) return;
      this.connected = true;
      this.viewerConnected = true;
      this.updateViewState();
    }
    function disconnected(this: LiveView) {
      if (attempt === this.attempt && token === this.viewerToken) this.close('Disconnected');
    }
    const onConnected = connected.bind(this);
    const onDisconnected = disconnected.bind(this);
    viewer.addEventListener('connect', onConnected);
    viewer.addEventListener('disconnect', onDisconnected);
    if (channel.handshakeComplete) channel.replayHandshake();
  }

  private onLeaseNotice(attempt: number, notice: LeaseNotice) {
    const channel = this.channel;
    if (!channel) return;
    if (notice.lease === 'valid') {
      this.serverPaused = false;
      this.accessConfirmed.set(true);
      this.armLeaseDeadline(channel.localDeadline(notice));
      if (!this.viewer && channel.handshakeComplete) this.startViewer(attempt);
    } else {
      this.serverPaused = true;
      this.accessConfirmed.set(false);
      if (channel.handshakeComplete) this.clearPicture();
    }
    this.updateViewState();
  }

  private armLeaseDeadline(deadline: number) {
    clearTimeout(this.leaseTimer);
    this.leaseDeadline = deadline;
    this.locallyExpired = performance.now() >= deadline;
    const expire = this.expireLease.bind(this);
    const remainingMs = Math.max(0, deadline - performance.now());
    this.leaseTimer = setTimeout(expire, remainingMs);
  }

  private expireLease() {
    this.locallyExpired = true;
    this.updateViewState();
  }

  private updateViewState() {
    // connect may follow a stalled browser timer; compare the clock again before showing pixels.
    this.locallyExpired ||= performance.now() >= this.leaseDeadline;
    if (!this.connected) {
      this.state.set('Connecting');
    } else if (this.serverPaused || this.locallyExpired || !this.viewerConnected) {
      this.state.set('Paused');
    } else {
      if (this.state() !== 'Viewing') {
        this.viewedAt.set(new Date().toISOString());
      }
      this.state.set('Viewing');
    }
  }

  private socketClosed(attempt: number, event: CloseEvent): void {
    if (attempt !== this.attempt) return;
    const state = stateForCloseCode(event.code);
    this.close(state);
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
