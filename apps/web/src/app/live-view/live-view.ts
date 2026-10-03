import { ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild, type OnDestroy, type OnChanges, type SimpleChanges } from '@angular/core';
import type RFB from '@novnc/novnc/lib/rfb.js';

@Component({
  selector: 'oc-live-view', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section aria-label="Computer view"><header><div><h2>Computer</h2><span>Read-only · shared desktop</span></div>
    <button type="button" (click)="toggle()">{{ active() ? 'Close view' : 'View computer' }}</button></header>
    <p role="status" aria-live="polite">{{ state() }}</p>
    @if (state() === 'Access changed') { <p>Ask the desktop owner for access, or sign in again.</p> }
    <div class="display" #display tabindex="0" aria-label="Read-only computer display" [hidden]="state() !== 'Viewing'"></div>
    @if (state() === 'Viewing') { <div class="tools"><button type="button" [attr.aria-pressed]="fit()" (click)="zoom(true)">Fit</button>
      <button type="button" [attr.aria-pressed]="!fit()" (click)="zoom(false)">Actual size · zoom</button></div> }
    </section>`,
  styles: `:host{display:block;min-width:0}section{border:1px solid var(--border,#d9dfe0);border-radius:12px;padding:16px;background:#fbfcfc}
    header,.tools{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h2{margin:0 0 4px;font-size:18px}
    p,span{font-size:14px}button{min-height:44px;padding:8px 16px;border:1px solid #6d8388;border-radius:6px;background:#fff;color:#12343b;font:inherit;cursor:pointer}
    button:focus-visible,.display:focus-visible{outline:3px solid #138a9b;outline-offset:3px}.display{height:min(60vh,600px);width:100%;overflow:auto;background:#172a2d}
    .display[hidden]{display:none}.tools{justify-content:flex-start;margin-top:12px}@media(max-width:500px){header>button{width:100%}section{padding:12px}.display{height:300px}}`,
})
export class LiveView implements OnDestroy, OnChanges {
  readonly conversationId = input.required<string>();
  private readonly display = viewChild.required<ElementRef<HTMLElement>>('display');
  protected readonly state = signal('Disconnected');
  protected readonly active = signal(false);
  protected readonly fit = signal(true);
  private viewer: RFB | undefined;
  private socket: WebSocket | undefined;
  private attempt = 0;
  protected toggle(): void { if (this.active()) this.close('Disconnected'); else void this.open(); }
  protected zoom(fit: boolean): void { this.fit.set(fit); if (this.viewer) this.viewer.scaleViewport = fit; }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['conversationId'] && !changes['conversationId'].firstChange) this.close('Disconnected');
  }
  ngOnDestroy(): void { this.close('Disconnected'); }
  private close(state: string): void {
    this.attempt++; this.active.set(false); this.viewer?.disconnect(); this.socket?.close();
    this.viewer = undefined; this.socket = undefined; this.display().nativeElement.replaceChildren(); this.state.set(state);
  }
  private async open(): Promise<void> {
    const attempt = ++this.attempt; this.active.set(true); this.state.set('Connecting');
    try {
      const url = `/api/conversations/${encodeURIComponent(this.conversationId())}/view`;
      const response = await fetch(url, { method: 'POST', headers: { 'x-opencrane-view': '1' } });
      if (attempt !== this.attempt) return;
      if (response.status === 401 || response.status === 403) return this.close('Access changed');
      if (!response.ok) throw new Error('View unavailable');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('ticket' in result) || typeof result.ticket !== 'string') throw new Error('View unavailable');
      const { default: Rfb } = await import('./viewer');
      if (attempt !== this.attempt) return;
      const address = new URL(`/ws/conversations/${encodeURIComponent(this.conversationId())}/view`, location.href); address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(address, ['binary', result.ticket]); this.socket = socket;
      socket.addEventListener('close', event => { if (attempt === this.attempt) this.close(event.code === 4003 ? 'Access changed' : 'Disconnected'); });
      const viewer = new Rfb(this.display().nativeElement, socket); this.viewer = viewer;
      viewer.viewOnly = true; viewer.scaleViewport = this.fit(); viewer.resizeSession = false; viewer.focusOnClick = false;
      viewer.addEventListener('connect', () => { if (attempt === this.attempt) this.state.set('Viewing'); });
      viewer.addEventListener('disconnect', () => { if (attempt === this.attempt) this.close('Disconnected'); });
    } catch { if (attempt === this.attempt) this.close('Disconnected'); }
  }
}
