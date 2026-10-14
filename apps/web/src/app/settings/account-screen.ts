import {
  afterNextRender, ChangeDetectionStrategy, Component, ElementRef, signal,
  ViewChild, type OnDestroy,
} from '@angular/core';
import { z } from 'zod';
import { ChatIcon } from '../chat/icon';
import { SharedState } from '../shared-state/shared-state';

const identityResponse = z.object({
  authenticated: z.boolean(),
  user: z.object({ name: z.string().optional() }).nullable(),
});

type IdentityState = 'loading' | 'ready' | 'signed-out' | 'failed';

@Component({
  selector: 'oc-account-screen',
  imports: [ChatIcon, SharedState],
  templateUrl: './account-screen.html',
  styleUrl: './account-screen.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountScreen implements OnDestroy {
  @ViewChild('accountHeading') private accountHeading?: ElementRef<HTMLHeadingElement>;
  protected readonly identityState = signal<IdentityState>('loading');
  protected readonly identityName = signal('');
  protected readonly surveyLink = signal(false);
  protected readonly announcement = signal('');
  private request = new AbortController();

  constructor() {
    afterNextRender(this.startIdentityCheck.bind(this));
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  private async loadIdentity(): Promise<void> {
    this.identityState.set('loading');
    this.identityName.set('');
    this.announcement.set('Checking your signed-in identity.');
    this.request.abort();
    const request = new AbortController();
    this.request = request;
    try {
      const response = await fetch('/auth/me', {
        cache: 'no-store',
        signal: request.signal,
      });
      if (!response.ok) throw new Error('Identity read failed');
      const body: unknown = await response.json();
      const identity = identityResponse.parse(body);
      if (!identity.authenticated) {
        this.identityState.set('signed-out');
        this.announcement.set('Your session expired.');
        return;
      }
      this.identityName.set(identity.user?.name?.trim() ?? '');
      this.identityState.set('ready');
      void this.loadSurveyState(request);
      if (this.identityName()) {
        this.announcement.set('Identity loaded from your current session.');
      } else {
        this.announcement.set(
          'Identity loaded from your current session. A display name was not provided.',
        );
      }
    } catch {
      if (request.signal.aborted) return;
      this.identityState.set('failed');
      this.announcement.set("Couldn't load your identity.");
    }
  }

  private async loadSurveyState(request: AbortController): Promise<void> {
    this.surveyLink.set(false);
    try {
      const response = await fetch('/api/onboarding', {
        cache: 'no-store', signal: request.signal,
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      const parsed = z.object({ state: z.string() }).parse(body);
      if (request.signal.aborted) return;
      this.surveyLink.set(parsed.state === 'not_started' || parsed.state === 'survey');
    } catch {
      this.surveyLink.set(false);
    }
  }

  private startIdentityCheck(): void {
    void this.loadIdentity();
  }

  protected async retryIdentity(): Promise<void> {
    await this.loadIdentity();
    this.accountHeading?.nativeElement.focus();
  }
}
