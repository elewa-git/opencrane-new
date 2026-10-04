import { ChangeDetectionStrategy, Component, signal, type OnInit } from '@angular/core';
import { z } from 'zod';

const messages: Record<string, string> = {
  token_used: 'This token has already been used.',
  owner_exists: 'This silo already has an owner. Ask them for an invitation.',
  token_expired: 'This token has expired. Ask the installer for a new token.',
  wrong_token: 'That token is incorrect. Check it with the installer.',
  wrong_organisation: 'Use an account from this silo’s organisation.',
  concurrent_claim: 'Someone else claimed this silo at the same time.',
  rate_limited: 'Too many attempts. Wait one minute before trying again.',
  no_session: 'Your session has expired. Sign in again to claim.',
  wrong_origin: 'This request came from another site. Reload this page.',
  invalid_request: 'Enter a display name, a valid contact email and the token.',
};

@Component({
  selector: 'oc-claim', templateUrl: './claim.html', styleUrl: './claim.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Claim implements OnInit {
  protected readonly state = signal<'loading' | 'signin' | 'ready' | 'claimed' | 'unavailable'>('loading');
  protected readonly pending = signal(false);
  protected readonly message = signal('');
  protected readonly name = signal('');

  ngOnInit(): void { void this.session(); }
  private async session(): Promise<void> {
    try {
      const response = await fetch('/auth/me', { cache: 'no-store' });
      const body = z.object({ authenticated: z.boolean(), user: z.object({ name: z.string().optional() }).nullable() }).parse(await response.json());
      if (!response.ok) throw new Error('Session unavailable');
      this.name.set(body.user?.name ?? '');
      this.state.set(body.authenticated ? 'ready' : 'signin');
    } catch { this.state.set('unavailable'); }
  }
  protected async claim(event: Event, form: HTMLFormElement, tokenInput: HTMLInputElement): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;
    const data = new FormData(form);
    const token = tokenInput.value;
    tokenInput.value = '';
    this.pending.set(true); this.message.set('');
    try {
      const response = await fetch('/api/silo/claim', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, displayName: data.get('displayName'), email: data.get('email') }) });
      const body = z.object({ status: z.enum(['claimed', 'refused', 'unavailable']), reason: z.string().optional() }).parse(await response.json());
      if (response.status === 201 && body.status === 'claimed') { this.state.set('claimed'); return; }
      if (body.status === 'refused') {
        this.message.set(messages[body.reason ?? ''] ?? 'This claim was refused. Check with the installer.');
        if (body.reason === 'no_session') this.state.set('signin');
      } else this.message.set('We could not confirm your claim. A later attempt will check whether an owner exists.');
    } catch { this.message.set('We could not confirm your claim. A later attempt will check whether an owner exists.'); }
    finally { this.pending.set(false); }
  }
}
