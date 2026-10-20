import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import { budgetStopStatusSchema, type BudgetStopStatus } from '@opencrane/protocol';
import { money } from '../spending/spending-money';
import { ReadFailure, requestChat } from './chat-session-http';

type Stopped = Extract<BudgetStopStatus, { status: 'stopped' }>;
type Reason = Stopped['reasons'][number];
type Call = Stopped['calls'][number];
type Execution = Stopped['work'][number]['execution'];

@Component({
  selector: 'oc-budget-stop-notice',
  templateUrl: './budget-stop-notice.html',
  styleUrl: './budget-stop-notice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BudgetStopNotice {
  readonly conversationId = input('');
  readonly turnId = input('');
  readonly reconnectedAt = input('');
  readonly endedAt = input('');
  readonly denied = input(false);
  readonly now = input('');

  protected readonly details = signal<Stopped | undefined>(undefined);
  protected readonly unavailable = signal(false);
  protected readonly accessChanged = signal(false);
  protected readonly loading = signal(false);
  protected readonly notStopped = signal(true);
  private readonly readAt = signal('');
  private readVersion = 0;
  private selectedConversationId = '';
  private selectedTurnId = '';

  protected readonly execution = computed(this.matchingExecution.bind(this));
  protected readonly newPeriod = computed(this.newPeriodLine.bind(this));

  constructor() {
    effect(this.onInputsChanged.bind(this));
  }

  private matchingExecution(): string {
    const details = this.details();
    if (!details) return '';
    const turnId = this.turnId();
    for (const item of details.work) {
      if (item.turnId === turnId) return this.executionWords(item.execution);
    }
    return '';
  }

  private newPeriodLine(): string {
    const details = this.details();
    if (!details) return '';
    let latestReason = details.reasons[0]!;
    for (const reason of details.reasons) {
      if (reason.remedy !== 'ask_admin_or_wait') return '';
      if (Date.parse(reason.resetAt) > Date.parse(latestReason.resetAt)) latestReason = reason;
    }
    const latest = Date.parse(latestReason.resetAt);
    const checkedAt = this.readAt();
    if (!checkedAt) return '';
    const readTime = Date.parse(checkedAt);
    if (readTime < latest) return '';
    const period = latestReason.period;
    return `${this.utcDate(new Date(latest).toISOString())} — new ${period} limit. `
      + 'The stopped work was not repeated.';
  }

  private onInputsChanged(onCleanup: (cleanup: () => void) => void): void {
    const conversationId = this.conversationId();
    const turnId = this.turnId();
    this.reconnectedAt();
    this.endedAt();
    const denied = this.denied();
    const version = ++this.readVersion;
    onCleanup(this.invalidateRead.bind(this));
    if (denied || !conversationId || !turnId) {
      this.details.set(undefined);
      this.accessChanged.set(denied);
      return;
    }
    if (conversationId !== this.selectedConversationId || turnId !== this.selectedTurnId) {
      this.details.set(undefined);
    }
    this.selectedConversationId = conversationId;
    this.selectedTurnId = turnId;
    this.accessChanged.set(false);
    void this.read(conversationId, turnId, version);
  }

  private invalidateRead(): void {
    this.readVersion += 1;
  }

  protected heading(reason: Reason): string {
    const names = { global: 'Organisation', paying_group: 'Group', assistant: 'Assistant' };
    const limit = reason.limitCents === undefined ? '' : `: ${money(reason.limitCents)}`;
    return `${names[reason.scope]} ${reason.period} limit reached${limit}.`;
  }

  protected remedy(reason: Reason): string {
    if (reason.remedy === 'ask_admin') {
      return "Waiting for the reset won't help. Ask an admin to review the limit.";
    }
    return `Resets ${this.utcDate(reason.resetAt)}. Ask an admin to review the limit.`;
  }

  protected checkStatus(): void {
    if (this.loading() || this.accessChanged() || this.denied()) return;
    const conversationId = this.conversationId();
    const turnId = this.turnId();
    if (!conversationId || !turnId) return;
    void this.read(conversationId, turnId, ++this.readVersion);
  }

  protected callStatus(call: Call): string {
    const names = {
      held: 'Reserved',
      possibly_sent: 'Outcome unknown',
      charged: 'Recorded charge',
      released: 'Reservation released',
    };
    return names[call.status];
  }

  protected callExplanation(call: Call): string {
    if (call.status === 'held') {
      return 'The reservation is held for this call.';
    }
    if (call.status === 'possibly_sent') {
      return 'The call may have been sent. Its outcome is not known.';
    }
    if (call.status === 'charged') {
      return 'A charge is recorded for this call.';
    }
    return 'The reservation was released.';
  }

  protected callAmount(call: Call): string {
    if (call.status === 'charged' && call.chargedCents !== undefined) {
      return `Charged: ${money(call.chargedCents)}`;
    }
    if ((call.status === 'held' || call.status === 'possibly_sent')
      && call.heldCents !== undefined) {
      return `Reserved: ${money(call.heldCents)}`;
    }
    return '';
  }

  private executionWords(execution: Execution): string {
    if (execution === 'not_started') return 'Stopped before it started';
    if (execution === 'stopping') return 'Stopping';
    return 'Stopped';
  }

  private utcDate(value: string): string {
    const date = new Date(value);
    const day = date.getUTCDate();
    const month = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(date);
    const year = date.getUTCFullYear();
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${day} ${month} ${year}, ${hours}:${minutes} UTC`;
  }

  private async read(conversationId: string, turnId: string, version: number): Promise<void> {
    this.loading.set(true);
    this.unavailable.set(false);
    this.notStopped.set(false);
    this.readAt.set('');
    const path = `/api/conversations/${encodeURIComponent(conversationId)}`
      + `/budget-stops?turnId=${encodeURIComponent(turnId)}`;
    try {
      const response = await requestChat(path);
      const result = budgetStopStatusSchema.parse(response);
      if (!this.current(conversationId, turnId, version)) return;
      this.details.set(result.status === 'stopped' ? result : undefined);
      this.notStopped.set(result.status === 'not_stopped');
      this.readAt.set(this.now() || new Date().toISOString());
    } catch (error) {
      if (!this.current(conversationId, turnId, version)) return;
      if (error instanceof ReadFailure && (error.status === 401 || error.status === 403)) {
        this.details.set(undefined);
        this.accessChanged.set(true);
      } else {
        this.unavailable.set(true);
      }
    } finally {
      if (this.current(conversationId, turnId, version)) this.loading.set(false);
    }
  }

  private current(conversationId: string, turnId: string, version: number): boolean {
    return version === this.readVersion && !this.denied()
      && conversationId === this.conversationId() && turnId === this.turnId();
  }
}
