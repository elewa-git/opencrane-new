import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, computed, effect, inject,
  input, output, signal,
} from '@angular/core';
import { z } from 'zod';
import { approvalCardsSchema, type ApprovalCard } from '@opencrane/protocol';
import { HingeDrawer } from '../ui/hinge-drawer';
import { DogEar } from '../ui/paper';
import { SharedState } from '../shared-state/shared-state';
import { ApprovalLedger } from './approval-ledger';
import { ApprovalTerminalLine } from './approval-terminal-line';
import { ApprovalPresentation } from './approval-presentation';

import {
  checkedState, clearDecidedStates, failedCheckState, isCurrentConversation, isCurrentRead,
  isRequested, isTerminal, type Decision, type LocalState,
} from './approval-state';

interface DrawerState {
  approvalId: string;
  opener: HTMLElement;
  open: boolean;
  returnFocusTo?: HTMLElement;
}

const responseSchema = z.object({ cards: approvalCardsSchema, csrf: z.string() });

@Component({
  selector: 'oc-approval-cards',
  imports: [HingeDrawer, DogEar, SharedState, ApprovalLedger, ApprovalTerminalLine],
  templateUrl: './approvals.html',
  styleUrl: './approvals.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.aria-busy]': 'loading()' },
})
export class ApprovalCards {
  readonly conversationId = input.required<string>();
  readonly viewerId = input.required<string>();
  readonly waitingOnViewer = output<boolean>();
  protected readonly cards = signal<ApprovalCard[]>([]);
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly readFailed = signal(false);
  protected readonly checkingAccess = signal(false);
  protected readonly hadCards = signal(false);
  protected readonly busyChecks = signal<Record<string, boolean>>({});
  protected readonly checkingReadFailure = signal(false);
  protected readonly states = signal<Record<string, LocalState>>({});
  protected readonly announced = signal('');
  protected readonly drawer = signal<DrawerState | undefined>(undefined);
  protected readonly orderedCards = computed(() => {
    const all = this.cards();
    const terminal = all.filter(isTerminal);
    const pending = all.filter(isRequested);
    return [...terminal, ...pending];
  });
  private csrf = '';
  private readVersion = 0;
  private conversationVersion = 0;
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly presentation = new ApprovalPresentation(
    () => this.viewerId(),
    () => this.conversationId(),
    card => this.localState(card),
    () => this.orderedCards(),
  );
  private focusApprovalId = '';
  private closeDrawerForApprovalId = '';
  private focusTranscriptAfterRender = false;
  private lastWaitingOnViewer = false;
  private readonly activeReads = new Set<string>();
  private readonly activeReadCounts = new Map<string, number>();

  constructor() {
    effect(onCleanup => {
      const conversationId = this.conversationId();
      this.conversationVersion += 1;
      this.readVersion += 1;
      this.cards.set([]);
      this.states.set({});
      this.busyChecks.set({});
      this.csrf = '';
      this.loaded.set(false);
      this.loading.set(true);
      this.readFailed.set(false);
      this.checkingAccess.set(false);
      this.hadCards.set(false);
      this.drawer.set(undefined);
      this.announced.set('');
      this.focusApprovalId = '';
      this.closeDrawerForApprovalId = '';
      this.focusTranscriptAfterRender = false;
      this.lastWaitingOnViewer = false;
      if (!conversationId) return;
      const abort = new AbortController();
      void this.read(conversationId, abort.signal, 'poll');
      const timer = setInterval(() => {
        void this.read(conversationId, abort.signal, 'poll');
      }, 3000);
      onCleanup(() => {
        abort.abort();
        clearInterval(timer);
      });
    });
    effect(() => this.emitWaitingOnViewer());
    afterEveryRender(() => this.restoreFocus());
  }

  protected localState(card: ApprovalCard): LocalState | undefined {
    return this.states()[card.approvalId];
  }

  protected isSubmitting(card: ApprovalCard): boolean {
    return this.localState(card)?.kind === 'submitting';
  }

  protected isBlocked(card: ApprovalCard): boolean {
    const state = this.localState(card);
    return this.readFailed() || this.checkingAccess() || state?.kind === 'submitting'
      || state?.kind === 'unknown';
  }

  protected async decide(card: ApprovalCard, decision: Decision, fromDrawer = false): Promise<void> {
    if (!this.canStartDecision(card, decision)) return;
    const conversationId = this.conversationId();
    this.setState(card.approvalId, { kind: 'submitting', decision });
    this.announced.set(decision === 'approved' ? 'Sending your approval…' : 'Sending your denial…');
    const version = this.conversationVersion;
    try {
      const response = await fetch(`/api/conversations/${conversationId}/approvals`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', 'x-csrf-token': this.csrf },
        body: JSON.stringify({ approvalId: card.approvalId, decision }),
      });
      if (!isCurrentConversation(conversationId, this.conversationId(), version,
        this.conversationVersion)) return;
      await this.applyDecisionResponse(response, card, decision, fromDrawer, conversationId);
    } catch {
      this.applyUnknownDecisionReply(card, decision, conversationId, version);
    }
  }

  private canStartDecision(card: ApprovalCard, decision: Decision): boolean {
    const state = this.localState(card);
    if (this.isBlocked(card)) return false;
    if (!state) return true;
    if (state.kind === 'step_up') return decision === 'rejected';
    return state.kind === 'not_recorded' || state.kind === 'conflict'
      || state.kind === 'still_open';
  }

  private async applyDecisionResponse(
    response: Response,
    card: ApprovalCard,
    decision: Decision,
    fromDrawer: boolean,
    conversationId: string,
  ): Promise<void> {
    if (response.status === 428) return this.applyStepUp(card, decision);
    if (response.status === 409) {
      await this.applyConflict(card, decision, fromDrawer, conversationId);
      return;
    }
    if (response.status === 400 || response.status === 403) {
      await this.applyKnownRefusal(card, decision, conversationId);
      return;
    }
    if (!response.ok) {
      this.applyUnknownDecision(card, decision);
      return;
    }
    await this.read(conversationId, undefined, 'decision');
    this.announceDecision(this.findCard(card.approvalId));
    this.focusIfTerminal(card.approvalId, fromDrawer);
  }

  private applyStepUp(card: ApprovalCard, decision: Decision): void {
    this.setState(card.approvalId, { kind: 'step_up', decision });
    this.announced.set('Your sign-in is older than this approval allows.');
  }

  private async applyConflict(
    card: ApprovalCard,
    decision: Decision,
    fromDrawer: boolean,
    conversationId: string,
  ): Promise<void> {
    this.setState(card.approvalId, { kind: 'conflict', decision });
    await this.read(conversationId, undefined, 'decision');
      this.announceDecision(this.findCard(card.approvalId));
    this.focusIfTerminal(card.approvalId, fromDrawer);
  }

  private async applyKnownRefusal(
    card: ApprovalCard,
    decision: Decision,
    conversationId: string,
  ): Promise<void> {
    this.setState(card.approvalId, { kind: 'not_recorded', decision });
    await this.read(conversationId, undefined, 'decision');
    const current = this.findCard(card.approvalId);
    if (current?.state !== 'requested') return;
    if (current.canDecide) {
      this.setState(card.approvalId, { kind: 'not_recorded', decision });
      this.announced.set('Your decision was not recorded. You can decide again.');
      return;
    }
    this.setState(card.approvalId, { kind: 'not_decidable', decision });
  }

  private applyUnknownDecision(card: ApprovalCard, decision: Decision): void {
    if (this.findCard(card.approvalId)?.state !== 'requested') return;
    this.setState(card.approvalId, { kind: 'unknown', decision, repeated: false });
    this.announced.set('Decision not confirmed');
  }

  private applyUnknownDecisionReply(
    card: ApprovalCard,
    decision: Decision,
    conversationId: string,
    version: number,
  ): void {
    if (!isCurrentConversation(conversationId, this.conversationId(), version,
      this.conversationVersion)) return;
    this.applyUnknownDecision(card, decision);
  }

  protected async checkStatus(card: ApprovalCard): Promise<void> {
    const conversationId = this.conversationId();
    const conversationVersion = this.conversationVersion;
    const current = this.localState(card);
    if (this.busyChecks()[card.approvalId]) return;
    this.busyChecks.update(checks => ({ ...checks, [card.approvalId]: true }));
    if (current?.kind === 'unknown') {
      this.setState(card.approvalId, { ...current, repeated: true });
    }
    try {
      await this.read(conversationId, undefined, 'check', card.approvalId);
      if (!isCurrentConversation(conversationId, this.conversationId(), conversationVersion,
        this.conversationVersion)) return;
      const updatedCard = this.findCard(card.approvalId);
      const updatedState = this.localStateById(card.approvalId);
      if (updatedCard?.state === 'outcome_unknown') this.announced.set('Result not confirmed');
      if (updatedCard?.state === 'approved') this.announced.set('Approved');
      if (updatedCard?.state === 'denied') this.announced.set('Denied');
      if (updatedState?.kind === 'still_open') {
        this.announced.set(this.presentation.statusMessage(updatedCard ?? card));
      }
    } finally {
      this.busyChecks.update(checks => ({ ...checks, [card.approvalId]: false }));
    }
  }

  protected openDrawer(card: ApprovalCard, opener: HTMLElement): void {
    this.drawer.set({ approvalId: card.approvalId, opener, open: true });
  }

  protected openDrawerFromEvent(card: ApprovalCard, event: MouseEvent): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    this.openDrawer(card, event.currentTarget);
  }

  protected drawerCard(): ApprovalCard | undefined {
    const drawer = this.drawer();
    if (!drawer) return undefined;
    return this.findCard(drawer.approvalId);
  }

  protected drawerClosed(): void {
    const drawer = this.drawer();
    this.drawer.set(undefined);
    if (drawer?.returnFocusTo) {
      drawer.returnFocusTo.focus();
      this.focusApprovalId = '';
      return;
    }
    drawer?.opener.focus();
  }

  protected checkUnknown(card: ApprovalCard): void {
    void this.checkStatus(card);
  }

  protected checkBusy(card: ApprovalCard): boolean {
    return this.busyChecks()[card.approvalId] ?? false;
  }

  protected async checkReadFailure(): Promise<void> {
    if (this.checkingReadFailure()) return;
    this.checkingReadFailure.set(true);
    try {
      await this.read(this.conversationId(), undefined, 'check');
    } finally {
      this.checkingReadFailure.set(false);
    }
  }

  protected async decideFromDrawer(card: ApprovalCard, decision: Decision): Promise<void> {
    await this.decide(card, decision, true);
  }

  private async read(
    conversationId: string,
    abortSignal?: AbortSignal,
    purpose: 'poll' | 'decision' | 'check' = 'poll',
    checkingApprovalId?: string,
  ): Promise<void> {
    const activeCount = this.activeReadCounts.get(conversationId) ?? 0;
    if (this.shouldSkipPoll(purpose, activeCount)) return;
    const version = ++this.readVersion;
    if (checkingApprovalId && this.activeReads.has(checkingApprovalId)) return;
    if (checkingApprovalId) this.activeReads.add(checkingApprovalId);
    this.activeReadCounts.set(conversationId, activeCount + 1);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/approvals`, {
        signal: abortSignal ?? AbortSignal.timeout(15000),
      });
      await this.applyReadResponse(
        response, conversationId, version, abortSignal, purpose, checkingApprovalId,
      );
    } catch {
      if (!this.readIsCurrent(conversationId, version, abortSignal)) return;
      if (checkingApprovalId) {
        const failedState = failedCheckState(this.localStateById(checkingApprovalId));
        if (failedState) this.setState(checkingApprovalId, failedState);
      }
      this.loading.set(false);
      this.loaded.set(true);
      this.readFailed.set(true);
    } finally {
      if (checkingApprovalId) this.activeReads.delete(checkingApprovalId);
      const remainingCount = (this.activeReadCounts.get(conversationId) ?? 1) - 1;
      if (remainingCount === 0) this.activeReadCounts.delete(conversationId);
      else this.activeReadCounts.set(conversationId, remainingCount);
    }
  }

  private shouldSkipPoll(purpose: 'poll' | 'decision' | 'check', activeCount: number): boolean {
    return purpose === 'poll' && activeCount > 0;
  }

  private async applyReadResponse(
    response: Response,
    conversationId: string,
    version: number,
    abortSignal: AbortSignal | undefined,
    purpose: 'poll' | 'decision' | 'check',
    checkingApprovalId: string | undefined,
  ): Promise<void> {
    if (!this.readIsCurrent(conversationId, version, abortSignal)) return;
    if (response.status === 401 || response.status === 403) {
      this.applyAccessChange();
      return;
    }
    if (!response.ok) throw new Error('Approval read failed');
    const result = responseSchema.parse(await response.json());
    if (!this.readIsCurrent(conversationId, version, abortSignal)) return;
    this.applyReadResult(result, purpose, checkingApprovalId);
  }

  private applyReadResult(
    result: z.infer<typeof responseSchema>,
    purpose: 'poll' | 'decision' | 'check',
    checkingApprovalId: string | undefined,
  ): void {
    const firstRead = !this.loaded();
    const oldCards = this.cards();
    this.focusFoldedFocusedCard(oldCards, result.cards);
    this.cards.set(result.cards);
    this.csrf = result.csrf;
    this.loaded.set(true);
    this.loading.set(false);
    this.readFailed.set(false);
    this.checkingAccess.set(false);
    if (result.cards.length > 0) this.hadCards.set(true);
    this.updateLocalStates(result.cards);
    this.announceNewRequests(oldCards, result.cards, firstRead);
    this.followDrawer(result.cards);
    if (checkingApprovalId) this.finishCheckStatus(checkingApprovalId);
    if (purpose === 'decision') this.states.update(states => clearDecidedStates(states, result.cards));
  }

  private finishCheckStatus(approvalId: string): void {
    const current = this.localStateById(approvalId);
    const checked = checkedState(current, this.findCard(approvalId));
    if (checked) this.setState(approvalId, checked);
  }

  private updateLocalStates(cards: ApprovalCard[]): void {
    const presentIds = new Set(cards.map(card => card.approvalId));
    this.states.update(states => {
      const next = { ...states };
      for (const card of cards) {
        const state = next[card.approvalId];
        if (card.state !== 'requested') {
          delete next[card.approvalId];
          continue;
        }
        if (state?.kind === 'submitting' || state?.kind === 'unknown'
          || state?.kind === 'step_up' || state?.kind === 'still_open') continue;
      }
      for (const id of Object.keys(next)) {
        if (!presentIds.has(id)) delete next[id];
      }
      return next;
    });
  }

  private announceNewRequests(oldCards: ApprovalCard[], cards: ApprovalCard[], firstRead: boolean): void {
    if (firstRead) return;
    const oldIds = new Set(oldCards.map(card => card.approvalId));
    const added = cards.find(card => card.state === 'requested' && !oldIds.has(card.approvalId));
    if (!added) return;
    this.announced.set(`Approval needed: ${added.review.action}`);
  }

  private applyAccessChange(): void {
    const showNotice = this.hadCards();
    this.cards.set([]);
    this.csrf = '';
    this.states.set({});
    this.readFailed.set(false);
    this.checkingAccess.set(showNotice);
    this.loading.set(false);
    const drawer = this.drawer();
    this.drawer.set(undefined);
    if (drawer) this.focusTranscriptAfterRender = true;
    this.readVersion += 1;
  }

  private followDrawer(cards: ApprovalCard[]): void {
    const drawer = this.drawer();
    if (!drawer) return;
    const exists = cards.some(card => card.approvalId === drawer.approvalId);
    if (exists) return;
    this.drawer.set(undefined);
    this.focusTranscriptAfterRender = true;
  }

  private focusIfTerminal(approvalId: string, fromDrawer: boolean): void {
    const card = this.findCard(approvalId);
    if (!card || card.state === 'requested') return;
    const drawer = this.drawer();
    if (fromDrawer && drawer?.approvalId === approvalId) {
      const returnFocusTo = this.terminalButton(approvalId);
      this.focusApprovalId = approvalId;
      if (returnFocusTo) {
        this.drawer.set({ ...drawer, open: false, returnFocusTo });
      } else {
        this.closeDrawerForApprovalId = approvalId;
        this.drawer.set({ ...drawer });
      }
      return;
    }
    this.focusApprovalId = approvalId;
  }

  private restoreFocus(): void {
    if (this.closeDrawerForApprovalId) {
      this.closeDrawerAfterDecisionRender();
      return;
    }
    if (this.focusTranscriptAfterRender) {
      this.focusTranscriptAfterRender = false;
      this.focusTranscript();
      return;
    }
    if (!this.focusApprovalId) return;
    this.terminalButton(this.focusApprovalId)?.focus();
    this.focusApprovalId = '';
  }

  private closeDrawerAfterDecisionRender(): void {
    const approvalId = this.closeDrawerForApprovalId;
    this.closeDrawerForApprovalId = '';
    const drawer = this.drawer();
    const returnFocusTo = this.terminalButton(approvalId);
    if (!drawer || drawer.approvalId !== approvalId || !returnFocusTo) {
      this.drawer.set(undefined);
      this.focusApprovalId = approvalId;
      return;
    }
    this.drawer.set({ ...drawer, open: false, returnFocusTo });
  }

  private terminalButton(approvalId: string): HTMLElement | null {
    return this.root.nativeElement.querySelector<HTMLElement>(
      `oc-approval-terminal-line [data-approval="${approvalId}"]`,
    );
  }

  private focusFoldedFocusedCard(oldCards: ApprovalCard[], newCards: ApprovalCard[]): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const focusedCard = oldCards.find(card => {
      const section = this.root.nativeElement.querySelector<HTMLElement>(
        `.approval.pending[data-approval="${card.approvalId}"]`,
      );
      return section?.contains(active) ?? false;
    });
    if (!focusedCard) return;
    const updated = newCards.find(card => card.approvalId === focusedCard.approvalId);
    if (!updated || updated.state === 'requested') return;
    this.focusApprovalId = focusedCard.approvalId;
  }

  private focusTranscript(): void {
    const transcript = this.root.nativeElement.closest<HTMLElement>('.transcript');
    transcript?.focus();
  }

  private emitWaitingOnViewer(): void {
    const waiting = this.cards().some(card => card.state === 'requested' && card.canDecide);
    if (waiting === this.lastWaitingOnViewer) return;
    this.lastWaitingOnViewer = waiting;
    this.waitingOnViewer.emit(waiting);
  }

  private findCard(approvalId: string): ApprovalCard | undefined {
    return this.cards().find(card => card.approvalId === approvalId);
  }

  private localStateById(approvalId: string): LocalState | undefined {
    return this.states()[approvalId];
  }

  private setState(approvalId: string, state: LocalState): void {
    this.states.update(states => ({ ...states, [approvalId]: state }));
  }

  private announceDecision(card: ApprovalCard | undefined): void {
    const message = this.presentation.decisionAnnouncement(card);
    if (message) this.announced.set(message);
  }

  private readIsCurrent(
    conversationId: string,
    version: number,
    abortSignal?: AbortSignal,
  ): boolean {
    return isCurrentRead(conversationId, this.conversationId(), version,
      this.readVersion, abortSignal);
  }

}
