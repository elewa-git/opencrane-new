import { ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild, type OnDestroy, type OnChanges, type SimpleChanges } from '@angular/core';
import type RFB from '@novnc/novnc/lib/rfb.js';

@Component({
  selector: 'oc-live-view', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button class="entry" type="button" (click)="watch()">Watch your computer</button>
    <dialog #dialog aria-label="Computer view" (close)="close('Disconnected')"><section aria-label="Computer view"><header><div><h2>Computer</h2><span>{{ controlState() === 'You are in control' ? 'Exclusive control · shared desktop' : 'Read-only · shared desktop' }}</span></div>
    <button type="button" (click)="dialog.close()">Close view</button></header>
    @if (state() === 'Not available') { <p>A conversation participant needs a shared-desktop grant and a ready computer to watch. Ask the desktop owner for access.</p> }
    <p role="status" aria-live="polite">{{ state() }}</p>
    @if (state() === 'Access changed') { <p>Ask the desktop owner for access, or sign in again.</p> }
    <p role="status" aria-live="polite">{{ controlState() }}</p>
    @if (controlState() === 'Agent paused') { <p>Control closed safely. Release to resume checked work, or leave the agent paused. Uncertain external actions will not be retried.</p> }
    <div class="display" #display tabindex="0" [attr.aria-label]="controlState() === 'You are in control' ? 'Computer display · keyboard and pointer control' : 'Read-only computer display'" [hidden]="state() !== 'Viewing'"></div>
    <div class="tools control">
    @if (canControl() && !leaseId) { <button type="button" (click)="takeControl()" [disabled]="busy()">Take control</button> }
    @if (leaseId) { <button type="button" (click)="release()" [disabled]="busy()">Release</button>
      @if (controlState() === 'You are in control') { <button type="button" (click)="renew()" [disabled]="busy()">Renew control</button><span>Lease ends {{ expiresAt() }} · at most two minutes</span> }
    }
    </div>
    @if (state() === 'Viewing') { <div class="tools"><button type="button" [attr.aria-pressed]="fit()" (click)="zoom(true)">Fit</button>
      <button type="button" [attr.aria-pressed]="!fit()" (click)="zoom(false)">Actual size · zoom</button></div> }
    </section></dialog>`,
  styles: `:host{display:block;min-width:0}.entry{margin:12px 18px;width:calc(100% - 36px);text-align:left}
    dialog{width:min(1000px,94vw);max-height:90dvh;padding:0;border:0;border-radius:12px;color:#12343b}dialog::backdrop{background:#16191a55}section{border:1px solid var(--border,#d9dfe0);border-radius:12px;padding:16px;background:#fbfcfc}
    header,.tools{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h2{margin:0 0 4px;font-size:18px}
    p,span{font-size:14px}button{min-height:44px;min-width:44px;padding:8px 16px;border:1px solid #6d8388;border-radius:6px;background:#fff;color:#12343b;font:inherit;cursor:pointer}
    button:focus-visible,.display:focus-visible{outline:3px solid #138a9b;outline-offset:3px}.display{height:min(60vh,600px);width:100%;overflow:auto;background:#172a2d}
    .display[hidden]{display:none}.tools{justify-content:flex-start;margin-top:12px}@media(max-width:500px){header>button,.control>button{width:100%}section{padding:12px}.display{height:300px}}`,
})
export class LiveView implements OnDestroy, OnChanges {
  readonly conversationId = input.required<string>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly display = viewChild.required<ElementRef<HTMLElement>>('display');
  protected readonly state = signal('Disconnected');
  protected readonly fit = signal(true);
  protected readonly canControl = signal(false);
  protected readonly controlState = signal('');
  protected readonly busy = signal(false);
  protected readonly expiresAt = signal('');
  protected leaseId: string | undefined;
  private viewer: RFB | undefined;
  private socket: WebSocket | undefined;
  private attempt = 0;
  protected watch(): void { this.dialog().nativeElement.showModal(); void this.open(); }
  protected zoom(fit: boolean): void { this.fit.set(fit); if (this.viewer) this.viewer.scaleViewport = fit; }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['conversationId'] && !changes['conversationId'].firstChange) { this.dialog().nativeElement.close(); this.close('Disconnected'); this.leaseId = undefined; this.controlState.set(''); }
  }
  ngOnDestroy(): void { this.close('Disconnected'); }
  protected close(state: string): void {
    this.canControl.set(false);
    if (this.leaseId && this.controlState() !== 'Returning control') this.controlState.set('Agent paused');
    this.attempt++; this.viewer?.disconnect(); this.socket?.close();
    this.viewer = undefined; this.socket = undefined; this.display().nativeElement.replaceChildren(); this.state.set(state);
  }
  private async open(writer = false): Promise<void> {
    if (writer) this.close('Connecting');
    const attempt = ++this.attempt; this.state.set('Connecting');
    try {
      const url = `/api/conversations/${encodeURIComponent(this.conversationId())}/${writer ? 'control' : 'view'}`;
      const response = await fetch(url, { method: 'POST', headers: { 'x-opencrane-view': '1' } });
      if (attempt !== this.attempt) return;
      if (response.status === 401 || response.status === 403) { await this.refusedControl(writer); return; }
      if (!response.ok) throw new Error('View unavailable');
      const result = this.admission(await response.json() as unknown);
      if (writer) {
        if (!result.leaseId) throw new Error('Invalid lease');
        this.leaseId = result.leaseId; this.showExpiry(result);
      }
      const { default: Rfb } = await import('./viewer');
      if (attempt !== this.attempt) return;
      const address = new URL(`/ws/conversations/${encodeURIComponent(this.conversationId())}/${writer ? 'control' : 'view'}`, location.href); address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(address, ['binary', result.ticket]); this.socket = socket;
      socket.addEventListener('close', event => { if (attempt === this.attempt) this.close(event.code === 4003 ? 'Access changed' : 'Disconnected'); });
      const viewer = new Rfb(this.display().nativeElement, socket); this.viewer = viewer;
      viewer.viewOnly = !writer; viewer.scaleViewport = this.fit(); viewer.resizeSession = false; viewer.focusOnClick = writer;
      viewer.addEventListener('connect', () => {
        if (attempt !== this.attempt) return;
        this.state.set('Viewing');
        if (writer) { this.controlState.set('You are in control'); viewer.focus(); }
        else void this.controlStatus();
      });
      viewer.addEventListener('disconnect', () => { if (attempt === this.attempt) this.close('Disconnected'); });
    } catch { if (attempt === this.attempt) this.close('Disconnected'); }
  }
  private admission(value: unknown): { ticket: string; leaseId?: string; expiresAt?: string } {
    if (!value || typeof value !== 'object' || !('ticket' in value) || typeof value.ticket !== 'string') throw new Error('View unavailable');
    return { ticket: value.ticket,
      ...('leaseId' in value && typeof value.leaseId === 'string' ? { leaseId: value.leaseId } : {}),
      ...('expiresAt' in value && typeof value.expiresAt === 'string' ? { expiresAt: value.expiresAt } : {}) };
  }
  private async refusedControl(writer: boolean): Promise<void> {
    this.close(writer ? 'Viewing unavailable' : 'Not available');
    if (writer) { this.controlState.set('Agent paused'); await this.controlStatus(); }
  }
  protected takeControl(): void {
    this.busy.set(true); this.controlState.set('Taking control');
    void this.open(true).finally(() => this.busy.set(false));
  }
  private showExpiry(value: object): void {
    if ('expiresAt' in value && typeof value.expiresAt === 'string') this.expiresAt.set(new Date(value.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  private async controlStatus(): Promise<void> {
    const attempt = this.attempt;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(this.conversationId())}/control`, { method: 'POST', headers: { 'x-opencrane-view': '1', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) });
      const value: unknown = await response.json();
      if (attempt !== this.attempt || !response.ok || !value || typeof value !== 'object' || !('status' in value)) return;
      this.canControl.set(value.status === 'ready');
      if ('leaseId' in value && typeof value.leaseId === 'string') { this.leaseId = value.leaseId; this.controlState.set('Agent paused'); }
    } catch { /* Viewing stays available if control cannot be checked. */ }
  }
  protected async renew(): Promise<void> {
    this.busy.set(true);
    try { const result = await this.controlCommand('renew'); this.showExpiry(result); }
    catch { this.close('Disconnected'); }
    finally { this.busy.set(false); }
  }
  protected async release(): Promise<void> {
    this.busy.set(true); this.controlState.set('Returning control');
    try {
      await this.controlCommand('release'); this.close('Connecting'); this.leaseId = undefined; this.controlState.set(''); await this.open();
    } catch { this.controlState.set('Agent paused'); }
    finally { this.busy.set(false); }
  }
  private async controlCommand(action: 'renew' | 'release'): Promise<object> {
    const response = await fetch(`/api/conversations/${encodeURIComponent(this.conversationId())}/control`, { method: 'POST', headers: { 'x-opencrane-view': '1', 'content-type': 'application/json' }, body: JSON.stringify({ action, leaseId: this.leaseId }) });
    if (!response.ok) throw new Error('Agent paused');
    const result: unknown = await response.json(); if (!result || typeof result !== 'object') throw new Error('Agent paused'); return result;
  }

}
