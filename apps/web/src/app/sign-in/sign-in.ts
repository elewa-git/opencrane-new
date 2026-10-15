import {
  ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild,
  type AfterViewInit, type OnDestroy,
} from '@angular/core';
import { NAVIGATE } from '../core/navigate';
import { DogEar, PaperSurface } from '../ui/paper';
import { SharedState } from '../shared-state/shared-state';

const REJECTION_COPY = {
  unavailable: {
    message: 'We could not reach your identity provider',
    detail: 'No workspace session was created. Please try again. Nothing was created.',
  },
  rejected: {
    message: 'Your sign-in could not be completed',
    detail: 'The attempt may have expired or been refused. Please start again. Nothing was created.',
  },
} as const;

@Component({
  selector: 'oc-sign-in',
  imports: [SharedState, PaperSurface, DogEar],
  templateUrl: './sign-in.html',
  styleUrl: './sign-in.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignIn implements AfterViewInit, OnDestroy {
  private readonly navigate = inject(NAVIGATE);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly ssoButton = viewChild<ElementRef<HTMLButtonElement>>('ssoButton');
  private readonly heading = viewChild<ElementRef<HTMLHeadingElement>>('heading');

  protected readonly organisation = document.querySelector<HTMLMetaElement>(
    'meta[name=opencrane-org]',
  )?.content.trim() || 'this organisation';
  protected readonly invited = Boolean(new URLSearchParams(globalThis.location.search).get('invitation'));
  protected readonly handoff = globalThis.location.pathname === '/signin/handoff';
  protected readonly rejected = globalThis.location.pathname === '/signin/rejected';
  protected readonly rejection = this.rejectionCopy();
  protected readonly authenticated = signal(false);
  protected readonly authenticatedAt = signal<string | undefined>(undefined);
  protected readonly error = signal('');

  ngAfterViewInit(): void {
    if (this.handoff) {
      this.cancelButton()?.nativeElement.focus();
      this.timer = setTimeout(() => this.navigate('/auth/login?returnTo=/'), 2500);
      return;
    }
    if (this.rejected) {
      this.heading()?.nativeElement.focus();
      return;
    }
    void this.checkSession();
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  protected cancel(): void {
    clearTimeout(this.timer);
    this.navigate('/');
  }

  protected signIn(): void {
    this.navigate('/signin/handoff');
  }

  private rejectionCopy(): { message: string; detail: string } {
    const reason = new URLSearchParams(globalThis.location.search).get('reason');
    const copy = {
      organisation: {
        message: `Your account isn't part of ${this.organisation}`,
        detail: 'This account has no access here. Ask an admin for help. Nothing was created.',
      },
      unavailable: REJECTION_COPY.unavailable,
      rejected: REJECTION_COPY.rejected,
    };
    if (reason === 'organisation' || reason === 'unavailable') return copy[reason];
    return copy.rejected;
  }

  private async checkSession(): Promise<void> {
    try {
      const response = await fetch('/auth/me');
      const body: unknown = await response.json();
      const authenticated = response.ok && typeof body === 'object' && body !== null
        && 'authenticated' in body && body.authenticated === true;
      this.authenticated.set(authenticated);
      if (authenticated) {
        // Record when the session read confirmed this session.
        this.authenticatedAt.set(new Date().toISOString());
      } else {
        this.ssoButton()?.nativeElement.focus();
      }
    } catch {
      this.error.set('We could not check your session. You can try signing in again.');
    }
  }
}
