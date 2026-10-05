import {
  afterNextRender, ChangeDetectionStrategy, Component, signal, type OnDestroy,
} from '@angular/core';
import { z } from 'zod';
import { ChatIcon } from '../chat/icon';
import { SharedState } from '../shared-state/shared-state';

const identityResponse = z.object({
  authenticated: z.boolean(),
  user: z.object({ name: z.string().optional() }).nullable(),
});

@Component({
  selector: 'oc-account-screen',
  imports: [ChatIcon, SharedState],
  templateUrl: './account-screen.html',
  styleUrl: './account-screen.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountScreen implements OnDestroy {
  protected readonly loading = signal(true);
  protected readonly identityName = signal('');
  protected readonly unavailable = signal('');
  protected readonly announcement = signal('');
  private readonly request = new AbortController();

  constructor() {
    afterNextRender(this.startIdentityCheck.bind(this));
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  private async loadIdentity(): Promise<void> {
    try {
      const response = await fetch('/auth/me', {
        cache: 'no-store',
        signal: this.request.signal,
      });
      if (!response.ok) throw new Error('Identity read failed');
      const body: unknown = await response.json();
      const identity = identityResponse.parse(body);
      if (!identity.authenticated) {
        this.unavailable.set('Sign in to your organisation to load your identity.');
        this.announcement.set('Sign in to your organisation to load your identity.');
        return;
      }
      this.identityName.set(identity.user?.name?.trim() ?? '');
      if (this.identityName()) {
        this.announcement.set('Identity loaded from your current session.');
      } else {
        this.announcement.set(
          'Identity loaded from your current session. A display name was not provided.',
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.unavailable.set('We could not load identity from your current session.');
      this.announcement.set('We could not load identity from your current session.');
    } finally {
      if (!this.request.signal.aborted) this.loading.set(false);
    }
  }

  private startIdentityCheck(): void {
    if (this.request.signal.aborted) return;
    this.announcement.set('Checking your signed-in identity.');
    void this.loadIdentity();
  }
}
