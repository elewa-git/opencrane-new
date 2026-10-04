import { ChangeDetectionStrategy, Component, inject, signal, viewChild, ElementRef, type AfterViewInit, type OnDestroy } from '@angular/core';
import { NAVIGATE } from '../core/navigate';
import { FoldLoader } from '../ui/fold-loader/fold-loader';
import { SharedState } from '../shared-state/shared-state';

@Component({
  selector: 'oc-sign-in', imports: [SharedState, FoldLoader], templateUrl: './sign-in.html', styleUrl: './sign-in.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignIn implements AfterViewInit, OnDestroy {
  private readonly navigate = inject(NAVIGATE);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  protected readonly organisation = document.querySelector<HTMLMetaElement>('meta[name=opencrane-org]')?.content || 'Your organisation';
  protected readonly invited = Boolean(new URLSearchParams(globalThis.location.search).get('invitation'));
  protected readonly handoff = globalThis.location.pathname === '/signin/handoff';
  protected readonly rejected = globalThis.location.pathname === '/signin/rejected';
  protected readonly reason = new URLSearchParams(globalThis.location.search).get('reason');
  protected readonly authenticated = signal(false);
  protected readonly authenticatedAt = signal<string | undefined>(undefined);
  protected readonly error = signal('');

  ngAfterViewInit(): void {
    if (this.handoff) {
      this.cancelButton()?.nativeElement.focus();
      this.timer = setTimeout(() => this.navigate('/auth/login?returnTo=/'), 2500);
    } else if (!this.rejected) void this.checkSession();
  }
  ngOnDestroy(): void { clearTimeout(this.timer); }
  protected cancel(): void {
    clearTimeout(this.timer);
    this.navigate('/');
  }
  protected signIn(): void { this.navigate('/signin/handoff'); }
  private async checkSession(): Promise<void> {
    try {
      const response = await fetch('/auth/me');
      const body: unknown = await response.json();
      const authenticated = response.ok && typeof body === 'object' && body !== null
        && 'authenticated' in body && body.authenticated === true;
      this.authenticated.set(authenticated);
      if (authenticated) {
        // This timestamp records when the session read confirmed the active session.
        this.authenticatedAt.set(new Date().toISOString());
      }
    } catch { this.error.set('We could not check your session. You can try signing in again.'); }
  }
}
