import { Injectable, type OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class BrowserSession implements OnDestroy {
  private readonly ended = new Subject<void>();
  readonly signedOut = this.ended.asObservable();
  private readonly channel = typeof BroadcastChannel === 'undefined'
    ? undefined : new BroadcastChannel('opencrane-session');
  private readonly checkOnReturn = this.returned.bind(this);
  private readonly receiveSignOut = this.receive.bind(this);
  private stopped = false;
  private checking = false;
  private request: AbortController | undefined;

  constructor() {
    this.channel?.addEventListener('message', this.receiveSignOut);
    window.addEventListener('focus', this.checkOnReturn);
    window.addEventListener('pageshow', this.checkOnReturn);
    document.addEventListener('visibilitychange', this.checkOnReturn);
  }

  isActive(): boolean {
    return !this.stopped;
  }

  acceptsPrivateFrames(): boolean {
    return !this.stopped && !this.checking;
  }

  signOut(): void {
    this.stop();
    this.channel?.postMessage('signed-out');
  }

  private receive(event: MessageEvent<unknown>): void {
    if (event.data === 'signed-out') this.stop();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.request?.abort();
    this.ended.next();
  }

  private returned(): void {
    if (document.visibilityState === 'hidden' || this.stopped || this.checking) return;
    // Block private delivery until the cookie has been checked again.
    this.checking = true;
    void this.checkSession();
  }

  private async checkSession(): Promise<void> {
    const request = new AbortController();
    this.request = request;
    function expire(): void {
      request.abort();
    }
    const timeout = setTimeout(expire, 5000);
    const options = { cache: 'no-store' as const, signal: request.signal };
    try {
      const response = await fetch('/auth/me', options);
      const body: unknown = await response.json();
      const authenticated = response.ok && typeof body === 'object' && body !== null
        && 'authenticated' in body && body.authenticated === true;
      if (!authenticated) this.stop();
    } catch {
      this.stop();
    } finally {
      clearTimeout(timeout);
      this.request = undefined;
      this.checking = false;
    }
  }

  ngOnDestroy(): void {
    this.stop();
    this.ended.complete();
    this.channel?.close();
    window.removeEventListener('focus', this.checkOnReturn);
    window.removeEventListener('pageshow', this.checkOnReturn);
    document.removeEventListener('visibilitychange', this.checkOnReturn);
  }
}
