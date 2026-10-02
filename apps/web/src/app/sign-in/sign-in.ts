import { ChangeDetectionStrategy, Component, inject, signal, viewChild, ElementRef, type AfterViewInit, type OnDestroy } from '@angular/core';
import { NAVIGATE } from '../core/navigate';
import { SharedState } from '../shared-state/shared-state';

@Component({
  selector: 'oc-sign-in', imports: [SharedState], templateUrl: './sign-in.html', styleUrl: './sign-in.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignIn implements AfterViewInit, OnDestroy {
  private readonly navigate = inject(NAVIGATE);
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  protected readonly seconds = signal(5);
  protected readonly organisation = document.querySelector<HTMLMetaElement>('meta[name=opencrane-org]')?.content || 'Your organisation';
  protected readonly invited = Boolean(new URLSearchParams(globalThis.location.search).get('invitation'));
  protected readonly handoff = globalThis.location.pathname === '/signin/handoff';
  protected readonly rejected = globalThis.location.pathname === '/signin/rejected';
  protected readonly reason = new URLSearchParams(globalThis.location.search).get('reason');
  protected readonly authenticated = signal(false);
  protected readonly error = signal('');

  ngAfterViewInit(): void {
    if (this.handoff) {
      this.cancelButton()?.nativeElement.focus();
      this.timer = setInterval(() => {
        this.seconds.update((value) => value - 1);
        if (this.seconds() === 0) {
          clearInterval(this.timer);
          this.navigate('/auth/login?returnTo=/');
        }
      }, 1000);
    } else if (!this.rejected) void this.checkSession();
  }
  ngOnDestroy(): void { clearInterval(this.timer); }
  protected cancel(): void {
    clearInterval(this.timer);
    this.navigate('/');
  }
  protected signIn(): void { this.navigate('/signin/handoff'); }
  private async checkSession(): Promise<void> {
    try {
      const response = await fetch('/auth/me');
      const body: unknown = await response.json();
      this.authenticated.set(response.ok && typeof body === 'object' && body !== null
        && 'authenticated' in body && body.authenticated === true);
    } catch { this.error.set('We could not check your session. You can try signing in again.'); }
  }
}
