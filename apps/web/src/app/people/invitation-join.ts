import { ChangeDetectionStrategy, Component, input, signal, type OnInit } from '@angular/core';
import { recordIdPattern } from '@opencrane/protocol';
import { z } from 'zod';
import { SignOut } from '../sign-in/sign-out';

type InvitationLink = { memberId: string; invitationId: string };
type JoinState = 'loading' | 'signin' | 'fresh-signin' | 'ready' | 'joined' |
  'wrong-account' | 'unavailable';
type JoinAttempt = { displayName: string; commandId: string };

const sessionSchema = z.object({ authenticated: z.boolean() });
const replySchema = z.object({
  status: z.enum(['joined', 'already_joined', 'refused', 'unavailable']),
  reason: z.string().optional(),
});
const requestDeadlineMs = 10_000;
const uncertain = 'We could not confirm your request. Try again with the same display name.';

export function invitationLink(pathname: string): InvitationLink | undefined {
  const [, route, memberId, invitationId, extra] = pathname.split('/');
  if (route !== 'join' || extra !== undefined || !memberId || !invitationId) return undefined;
  if (!recordIdPattern.test(memberId) || !recordIdPattern.test(invitationId)) return undefined;
  return { memberId, invitationId };
}

@Component({
  selector: 'oc-invitation-join',
  imports: [SignOut],
  templateUrl: './invitation-join.html',
  styleUrl: '../sign-in/entry-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvitationJoin implements OnInit {
  readonly invitation = input.required<InvitationLink>();
  protected readonly state = signal<JoinState>('loading');
  protected readonly sending = signal(false);
  protected readonly message = signal('');
  private attempt?: JoinAttempt;

  ngOnInit(): void {
    void this.checkSession();
  }

  protected signInLink(fresh = false): string {
    const { memberId, invitationId } = this.invitation();
    const path = `/join/${memberId}/${invitationId}`;
    const query = new URLSearchParams({ returnTo: path });
    if (fresh) {
      query.set('fresh', '1');
    }
    return `/auth/login?${query}`;
  }

  protected async accept(event: Event, name: string): Promise<void> {
    event.preventDefault();
    if (this.state() !== 'ready' || this.sending()) {
      return;
    }
    const displayName = name.trim();
    if (!displayName || displayName.length > 200) {
      this.message.set('Enter a display name of up to 200 characters.');
      return;
    }
    this.sending.set(true);
    this.message.set('');
    try {
      // A lost reply can be checked by repeating the same command.
      if (this.attempt?.displayName !== displayName) {
        this.attempt = { displayName, commandId: crypto.randomUUID() };
      }
      const command = { ...this.invitation(), ...this.attempt };
      const response = await fetch('/members/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(requestDeadlineMs),
      });
      const reply = replySchema.parse(await response.json());
      if (response.ok && (reply.status === 'joined' || reply.status === 'already_joined')) {
        this.state.set('joined');
      } else if (reply.status === 'refused') {
        this.refuse(reply.reason);
      } else {
        this.message.set(uncertain);
      }
    } catch {
      this.message.set(uncertain);
    } finally {
      this.sending.set(false);
    }
  }

  private async checkSession(): Promise<void> {
    try {
      const response = await fetch('/auth/me', {
        cache: 'no-store',
        signal: AbortSignal.timeout(requestDeadlineMs),
      });
      if (!response.ok) {
        this.state.set('unavailable');
        return;
      }
      const session = sessionSchema.parse(await response.json());
      this.state.set(session.authenticated ? 'ready' : 'signin');
    } catch {
      this.state.set('unavailable');
    }
  }

  private refuse(reason: string | undefined): void {
    if (reason === 'no_session') {
      this.state.set('signin');
    } else if (reason === 'sign_in_again') {
      this.state.set('fresh-signin');
    } else if (reason === 'wrong_identity' || reason === 'wrong_silo') {
      this.state.set('wrong-account');
    } else if (reason === 'expired_invitation') {
      this.message.set('This invitation has expired. Ask for a new invitation.');
    } else {
      this.message.set('This invitation could not be accepted. Ask the person who invited you to check it.');
    }
  }
}
