import { Component, ChangeDetectionStrategy, ElementRef, afterEveryRender, effect, inject, input, signal } from '@angular/core';
import { z } from 'zod';
import { approvalCardsSchema, type ApprovalCard } from '@opencrane/protocol';

@Component({ selector: 'oc-approval-cards', templateUrl: './approvals.html', styleUrl: './approvals.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class ApprovalCards {
  readonly conversationId = input.required<string>();
  protected readonly cards = signal<ApprovalCard[]>([]);
  protected readonly status = signal<Record<string, string>>({});
  protected readonly error = signal('');
  private csrf = '';
  private readVersion = 0;
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef);
  private focus = '';
  constructor() {
    effect(onCleanup => {
      const id = this.conversationId(); this.cards.set([]); this.status.set({}); this.csrf = '';
      if (!id) return;
      const abort = new AbortController();
      void this.refresh(id, abort.signal);
      const timer = setInterval(() => { void this.refresh(id, abort.signal); }, 3000);
      onCleanup(() => { abort.abort(); clearInterval(timer); });
    });
    afterEveryRender(() => {
      if (!this.focus) return;
      const element = this.root.nativeElement.querySelector<HTMLElement>(`[data-approval="${this.focus}"]`);
      element?.focus(); this.focus = '';
    });
  }
  protected async refresh(id = this.conversationId(), signal?: AbortSignal): Promise<void> {
    const version = ++this.readVersion;
    try {
      const response = await fetch(`/api/conversations/${id}/approvals`, { signal: signal ?? AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Read unavailable');
      const result = z.object({ cards: approvalCardsSchema, csrf: z.string() }).parse(await response.json());
      if (version !== this.readVersion || id !== this.conversationId() || signal?.aborted) return;
      this.csrf = result.csrf; this.cards.set(result.cards); this.error.set('');
    } catch { if (!signal?.aborted && id === this.conversationId()) this.error.set('Approval status unavailable. Check status before deciding.'); }
  }
  protected async decide(card: ApprovalCard, decision: 'approved' | 'rejected'): Promise<void> {
    if (this.status()[card.approvalId] === 'Submitting…') return;
    this.setStatus(card.approvalId, 'Submitting…');
    const id = this.conversationId();
    try {
      const response = await fetch(`/api/conversations/${id}/approvals`, { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', 'x-csrf-token': this.csrf }, body: JSON.stringify({ approvalId: card.approvalId, decision }) });
      if (id !== this.conversationId()) return;
      if (response.status === 428) this.setStatus(card.approvalId, 'Sign in again to approve this action.');
      else if (response.ok) this.setStatus(card.approvalId, '');
      else if ([400, 403, 409].includes(response.status)) this.setStatus(card.approvalId, 'Failed — check status to retry safely.');
      else throw new Error('Decision outcome unknown');
      await this.refresh(id);
    } catch { if (id === this.conversationId()) this.setStatus(card.approvalId, 'Outcome unknown — check status.'); }
    this.focus = card.approvalId;
  }
  protected async check(card: ApprovalCard): Promise<void> {
    await this.refresh();
    if (!this.error()) this.setStatus(card.approvalId, 'Failed — safe to retry');
  }
  protected blocked(card: ApprovalCard): boolean {
    const status = this.status()[card.approvalId];
    return !!this.error() || (!!status && status !== 'Failed — safe to retry');
  }
  protected signIn(card: ApprovalCard): string {
    return `/auth/login?approval=${card.approvalId}&returnTo=${encodeURIComponent('/workspace?conversation=' + this.conversationId())}`;
  }
  protected label(card: ApprovalCard): string {
    return { requested: 'Approval needed', approved: '✓ Approved', denied: 'Denied', expired: 'Expired', cancelled: 'Cancelled', outcome_unknown: 'Outcome unknown · approval used' }[card.state];
  }
  protected expiry(card: ApprovalCard): string { return new Date(card.expiresAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); }
  private setStatus(id: string, value: string): void { this.status.update(states => ({ ...states, [id]: value })); }
}
