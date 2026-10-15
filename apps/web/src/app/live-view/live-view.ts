import { ModalSheet } from '../ui/modal-sheet';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { CaptureStatus } from '../chat/capture-status';
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
import type { CaptureViewModel } from '../chat/screenshot-capture';

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
  imports: [SharedState, CaptureStatus, ModalSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-view.html',
  styleUrl: './live-view.css',
})
export class LiveView implements OnDestroy, OnChanges {
  readonly conversationId = input.required<string>();
  readonly capture = input<CaptureViewModel | undefined>();
  readonly captureBusy = input(false);
  readonly captureChecking = input(false);
  readonly captureCanStart = input(true);
  readonly captureRequested = output<void>();
  readonly captureRepeated = output<void>();
  readonly captureStatusChecked = output<void>();
  protected readonly viewedAt = signal<string | undefined>(undefined);
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
    }
  }
  ngOnDestroy(): void { this.close('Disconnected'); }
  protected close(state: string): void {
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
    // Ignore the old viewer's disconnect so it cannot close the new viewer or session.
    this.viewerToken++;
    const viewer = this.viewer;
    this.viewer = undefined;
    this.viewerConnected = false;
    viewer?.disconnect();
    this.channel?.detachViewer();
    this.display().nativeElement.replaceChildren();
  }

  protected requestCapture(): void {
    if (this.captureBusy() || !this.captureCanStart()) return;
    this.captureRequested.emit();
  }

  protected captureAction(): void {
    if (this.captureBusy()) return;
    if (this.capture()?.kind === 'unknown') {
      this.captureStatusChecked.emit();
      return;
    }
    if (this.capture()?.kind === 'failed' && this.capture()?.safeToRetry) {
      this.captureRepeated.emit();
    }
  }

  protected repeatCapture(): void {
    if (this.captureBusy()) return;
    this.captureRepeated.emit();
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
      this.connectViewer(result.ticket, attempt);
    } catch {
      if (attempt === this.attempt) this.close('Disconnected');
    }
  }

  private connectViewer(ticket: string, attempt: number) {
    const path = `/ws/conversations/${encodeURIComponent(this.conversationId())}/view`;
    const address = new URL(path, location.href);
    address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(address, ['binary', ticket]);
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
    // Check the clock again before showing pixels because a browser timer may have stalled.
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
