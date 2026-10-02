import { ChangeDetectionStrategy, Component, inject, signal, type OnInit, type OnDestroy } from '@angular/core';
import { logoutResponseSchema } from '@opencrane/protocol';
import { NAVIGATE } from '../core/navigate';
import { SharedState } from '../shared-state/shared-state';

@Component({
  selector: 'oc-sign-in', imports: [SharedState], templateUrl: './sign-in.html', styleUrl: './sign-in.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignIn implements OnInit, OnDestroy {
  private readonly navigate = inject(NAVIGATE);
  private timer: ReturnType<typeof setTimeout> | undefined;
  protected readonly handoff = globalThis.location.pathname === '/signin/handoff';
  protected readonly rejected = globalThis.location.pathname === '/signin/rejected';
  protected readonly reason = new URLSearchParams(globalThis.location.search).get('reason');
  protected readonly authenticated = signal(false);
  protected readonly pending = signal(false);
  protected readonly error = signal('');

  ngOnInit(): void {
    if (this.handoff) {
      this.timer = setTimeout(() => this.navigate('/auth/login?returnTo=/'), 100);
    } else if (!this.rejected) void this.checkSession();
  }
  ngOnDestroy(): void { clearTimeout(this.timer); }
  protected cancel(): void {
    clearTimeout(this.timer);
    globalThis.stop();
    this.navigate('/');
  }
  protected signIn(): void { this.navigate('/signin/handoff'); }
  protected async signOut(): Promise<void> {
    this.pending.set(true);
    this.error.set('');
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Sign-out could not be confirmed. Try again.');
      const result = logoutResponseSchema.parse(await response.json());
      this.authenticated.set(false);
      if (result.endSessionUrl) this.navigate(result.endSessionUrl);
      else this.error.set('You are signed out here. Your identity provider could not be reached to end its session.');
    } catch { this.error.set('Sign-out could not be confirmed. Try again.'); }
    finally { this.pending.set(false); }
  }
  private async checkSession(): Promise<void> {
    try {
      const response = await fetch('/auth/me');
      const body: unknown = await response.json();
      this.authenticated.set(response.ok && typeof body === 'object' && body !== null
        && 'authenticated' in body && body.authenticated === true);
    } catch { this.error.set('We could not check your session. You can try signing in again.'); }
  }
}
