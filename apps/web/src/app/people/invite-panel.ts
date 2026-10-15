import {
  ChangeDetectionStrategy, Component, input, output, signal, type OnDestroy,
} from '@angular/core';
import {
  invitationChangeSchema, invitationCommandSchema, invitationEmailInputSchema,
  invitationEmailSchema,
} from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { HingeDrawer } from '../ui/hinge-drawer';

type Pending = { commandId: string; memberId: string };
type Change = ReturnType<typeof invitationChangeSchema.parse>;
type Stage = 'form' | 'link' | 'unknown' | 'refused';

@Component({
  selector: 'oc-invite-panel',
  imports: [HingeDrawer, SharedState],
  templateUrl: './invite-panel.html',
  styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvitePanel implements OnDestroy {
  readonly allowed = input(false);
  readonly selectedTab = input('members');
  readonly accessLost = output<number>();
  readonly showInvitations = output<void>();
  readonly unavailable = signal(false);
  protected readonly opened = signal(false);
  protected readonly stage = signal<Stage>('form');
  protected readonly email = signal('');
  protected readonly role = signal<'member' | 'admin'>('member');
  protected readonly assistant = signal<'provision' | 'none'>('provision');
  protected readonly error = signal('');
  protected readonly refusal = signal('');
  protected readonly link = signal('');
  protected readonly expiresAt = signal('');
  protected readonly copyMessage = signal('');
  protected readonly checking = signal(false);
  protected readonly sending = signal(false);
  protected readonly statusMessage = signal('');
  protected readonly commandReference = signal('');
  protected opener?: HTMLButtonElement;
  private pending: Pending | undefined;
  private generation = 0;

  protected selectLink(): void {
    const field = document.getElementById('invitation-link');
    if (field instanceof HTMLInputElement) field.select();
  }

  ngOnDestroy(): void { this.generation += 1; }

  clearAccess(): void {
    this.generation += 1;
    this.pending = undefined;
    this.email.set('');
    this.link.set('');
    this.commandReference.set('');
    this.opened.set(false);
    this.sending.set(false);
    this.checking.set(false);
    this.unavailable.set(true);
  }

  open(button: HTMLButtonElement): void {
    if (!this.allowed() || this.pending || this.unavailable()) return;
    this.opener = button;
    this.stage.set('form');
    this.email.set('');
    this.error.set('');
    this.refusal.set('');
    this.role.set('member');
    this.assistant.set('provision');
    this.opened.set(true);
    requestAnimationFrame(this.focusForm.bind(this));
  }

  private focusForm(): void {
    if (!this.opened() || this.stage() !== 'form') return;
    document.getElementById('invite-email')?.focus();
  }

  protected openFromTab(event: Event): void {
    const target = event.currentTarget;
    if (target instanceof HTMLButtonElement) this.open(target);
  }

  protected close(): void {
    this.generation += 1;
    this.opened.set(false);
    this.sending.set(false);
    this.checking.set(false);
    this.pending = undefined;
    this.link.set('');
    this.copyMessage.set('');
  }

  protected drawerClosed(): void {
    // Keep the command ids when an uncertain reply closes the drawer.
    if (this.stage() === 'unknown') return;
    this.close();
  }

  protected emailChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.email.set(target.value);
    this.error.set('');
  }

  protected roleChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.value === 'member' || target.value === 'admin') this.role.set(target.value);
  }

  protected assistantChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.value === 'provision' || target.value === 'none') this.assistant.set(target.value);
  }

  protected async create(): Promise<void> {
    if (!this.opened() || !this.allowed() || this.sending() || this.pending) return;
    const normalisedEmail = this.email().trim().toLowerCase();
    const address = invitationEmailInputSchema.safeParse({ email: normalisedEmail });
    if (!address.success) {
      this.error.set('Enter a valid email address.');
      return;
    }
    this.email.set(normalisedEmail);
    this.sending.set(true);
    const generation = this.generation;
    const identity = await this.request('/api/invitations/identity', 'POST', address.data);
    if (generation !== this.generation) return;
    if (this.handleAccess(identity)) return;
    if (identity.status === 400) {
      this.error.set('Enter a valid email address.');
      this.sending.set(false);
      return;
    }
    const identityResult = invitationEmailSchema.safeParse(identity.body);
    if (!identity.ok || !identityResult.success || identityResult.data.email !== normalisedEmail) {
      this.sending.set(false);
      this.refuse('The address could not be checked. Nothing was created.');
      return;
    }
    await this.sendInvitation(normalisedEmail, generation);
  }

  private async sendInvitation(normalisedEmail: string, generation: number): Promise<void> {
    const command = invitationCommandSchema.parse({
      commandId: crypto.randomUUID(), memberId: crypto.randomUUID(), email: normalisedEmail,
      expectedSequence: 0, role: this.role(), personalAssistant: this.assistant(),
    });
    this.pending = { commandId: command.commandId, memberId: command.memberId };
    const created = await this.request('/api/invitations', 'POST', command);
    if (generation !== this.generation) return;
    this.sending.set(false);
    if (this.handleAccess(created)) return;
    if (created.status === 409) {
      this.pending = undefined;
      this.refuse(refusalText(created.body));
      return;
    }
    if (!created.ok) {
      this.showUnknown('The request may have been recorded. Check its status.');
      return;
    }
    await this.checkStatus();
  }

  protected async checkStatus(): Promise<void> {
    const pending = this.pending;
    if (!pending || this.checking()) return;
    this.checking.set(true);
    const generation = this.generation;
    const url = `/api/invitations/${pending.memberId}/command-changes/${pending.commandId}`;
    const checked = await this.request(url, 'GET');
    if (generation !== this.generation) return;
    this.checking.set(false);
    if (this.handleAccess(checked)) return;
    if (checked.status === 404) {
      this.showUnknown('No record yet. The invitation may still arrive.');
      return;
    }
    const parsed = invitationChangeSchema.safeParse(checked.body);
    if (!checked.ok || !parsed.success) {
      this.showUnknown('Could not check the request. Check status again.');
      return;
    }
    this.showChange(parsed.data);
  }

  protected async copy(): Promise<void> {
    const value = this.link();
    if (!value) return;
    const generation = this.generation;
    try {
      await navigator.clipboard.writeText(value);
      if (generation !== this.generation) return;
      this.copyMessage.set('Link copied');
    } catch {
      if (generation !== this.generation) return;
      const field = document.getElementById('invitation-link');
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
      this.copyMessage.set('Copy failed. The link is selected; copy it with your keyboard.');
    }
  }

  protected expiryLabel(): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', timeZoneName: 'short',
    }).format(new Date(this.expiresAt()));
  }

  private showChange(change: Change): void {
    if (change.status === 'recorded' && !change.result) {
      this.loseAccess(403);
      return;
    }
    if (change.status === 'recorded' && change.result) {
      if (!change.result.expiresAt) {
        this.showUnknown('The expiry could not be confirmed. Check status again.');
        return;
      }
      this.link.set(change.result.link);
      this.email.set(change.result.email);
      this.expiresAt.set(change.result.expiresAt);
      this.pending = undefined;
      this.unavailable.set(false);
      this.commandReference.set('');
      this.stage.set('link');
      this.opened.set(true);
      return;
    }
    if (change.status === 'refused') {
      this.pending = undefined;
      this.refuse(refusalText({ reason: change.reason }));
      return;
    }
    this.showUnknown('No record yet. The invitation may still arrive.');
  }

  private showUnknown(message: string): void {
    this.unavailable.set(true);
    this.showInvitations.emit();
    this.commandReference.set(this.pending?.commandId ?? '');
    this.statusMessage.set(message);
    this.stage.set('unknown');
    this.opened.set(false);
  }

  private refuse(message: string): void {
    this.unavailable.set(false);
    this.refusal.set(message);
    this.stage.set('refused');
    this.opened.set(true);
  }

  private handleAccess(result: { status: number }): boolean {
    if (result.status !== 401 && result.status !== 403) return false;
    this.loseAccess(result.status);
    return true;
  }

  private loseAccess(status: number): void {
    this.clearAccess();
    this.accessLost.emit(status);
  }

  private async request(url: string, method: 'GET' | 'POST', body?: unknown): Promise<{
    ok: boolean; status: number; body: unknown;
  }> {
    try {
      const options: RequestInit = { method, headers: { accept: 'application/json' } };
      if (body !== undefined) {
        options.headers = { accept: 'application/json', 'content-type': 'application/json' };
        options.body = JSON.stringify(body);
      }
      const response = await fetch(url, options);
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        result = undefined;
      }
      return { ok: response.ok, status: response.status, body: result };
    } catch {
      return { ok: false, status: 503, body: undefined };
    }
  }
}

function refusalText(body: unknown): string {
  const reason = typeof body === 'object' && body !== null && 'reason' in body
    ? body.reason : undefined;
  if (reason === 'identity_mismatch') {
    return "This email already has an invitation. Renewing it isn't available yet. Nothing was created.";
  }
  if (reason === 'already_member') return 'This person is already a member. Nothing was created.';
  if (reason === 'access_removed') return 'This person was removed. Nothing was created.';
  if (reason === 'concurrent_change') return 'The invitation changed. Nothing was created.';
  return 'The invitation was refused. Nothing was created.';
}
