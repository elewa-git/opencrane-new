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

type IdentityState = 'loading' | 'ready' | 'signed-out' | 'failed';

@Component({
  selector: 'oc-account-screen',
  imports: [ChatIcon, SharedState],
  templateUrl: './account-screen.html',
  styleUrl: './account-screen.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountScreen implements OnDestroy {
  protected readonly identityState = signal<IdentityState>('loading');
  protected readonly identityName = signal('');
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
        this.announcement.set('');
        return;
      }
      this.identityName.set(identity.user?.name?.trim() ?? '');
      this.identityState.set('ready');
      if (this.identityName()) {
        this.announcement.set('Identity loaded from your current session.');
      } else {
        this.announcement.set(
          'Identity loaded from your current session. A display name was not provided.',
        );
      }
    } catch (error) {
      if (request.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.identityState.set('failed');
      this.announcement.set('');
    }
  }

  private startIdentityCheck(): void {
    void this.loadIdentity();
  }

  protected retryIdentity(): void {
    void this.loadIdentity();
  }
}
