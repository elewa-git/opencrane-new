import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, computed, effect, inject,
  input, output, signal, type OnDestroy,
} from '@angular/core';
import { z } from 'zod';
import { approvalCardsSchema, type ApprovalCard } from '@opencrane/protocol';
import { HingeDrawer } from '../ui/hinge-drawer';
import { SharedState } from '../shared-state/shared-state';
import { ApprovalLedger } from './approval-ledger';
import { ApprovalTerminalLine } from './approval-terminal-line';
import { ApprovalPresentation } from './approval-presentation';
import { ApprovalDecisionStatus } from './approval-decision-status';
import { ApprovalFocus, type ApprovalDrawerState } from './approval-focus';
import { approvalReadSignal, type ApprovalReadPurpose } from './approval-read-signal';

import {
  canDenyCard, checkedState, findApprovalCard, hasApprovalWaitingOnViewer, isCurrentConversation,
  isCurrentRead, localStatesAfterRead, missingFieldReason, newRequestAnnouncement,
  orderedApprovalCards, statesDuringAccessCheck,
  type Decision, type LocalState,
} from './approval-state';

const responseSchema = z.object({ cards: approvalCardsSchema, csrf: z.string() });

@Component({
  selector: 'oc-approval-cards',
  imports: [
    HingeDrawer, SharedState, ApprovalLedger, ApprovalTerminalLine,
    ApprovalDecisionStatus,
  ],
  templateUrl: './approvals.html',
  styleUrl: './approvals.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.aria-busy]': 'loading()' },
})
export class ApprovalCards implements OnDestroy {
  readonly conversationId = input.required<string>();
  readonly viewerId = input.required<string>();
  readonly stoppedTurnIds = input<string[]>([]);
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
  protected readonly drawer = signal<ApprovalDrawerState | undefined>(undefined);
  protected readonly orderedCards = computed(() => orderedApprovalCards(this.cards()));
  private csrf = '';
  private readVersion = 0;
  private conversationVersion = 0;
  private readonly focus = new ApprovalFocus(
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement,
  );
  protected readonly presentation = new ApprovalPresentation(
    () => this.viewerId(),
    () => this.conversationId(),
    card => this.localState(card),
    () => this.orderedCards(),
  );
  private lastWaitingOnViewer = false;
  private readonly activeReads = new Set<string>();
  private readonly activeReadCounts = new Map<string, number>();
  private readonly announcedApprovalIds = new Set<string>();

  constructor() {
    effect(onCleanup => {
      const conversationId = this.conversationId();
      this.conversationVersion += 1;
      this.readVersion += 1;
      this.clearWaitingOnViewer();
      this.announcedApprovalIds.clear();
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
    afterEveryRender(() => this.focus.restoreFocus(this.drawer(), this.drawer));
  }

  ngOnDestroy(): void {
    this.clearWaitingOnViewer();
  }

  protected localState(card: ApprovalCard): LocalState | undefined {
    return this.states()[card.approvalId];
  }

  protected isSubmitting(card: ApprovalCard): boolean {
    return this.localState(card)?.kind === 'submitting';
  }

  protected isBlocked(card: ApprovalCard): boolean {
    const state = this.localState(card);
    return this.isStopped(card) || this.readFailed() || this.checkingAccess()
      || state?.kind === 'submitting'
      || state?.kind === 'recorded' || state?.kind === 'unknown'
      || state?.kind === 'conflict';
  }

  protected canApprove(card: ApprovalCard): boolean {
    return card.requesterId === this.viewerId()
      && !card.missingFields?.length && (card.canApprove ?? card.canDecide);
  }

  protected canDeny(card: ApprovalCard): boolean {
    return canDenyCard(card, this.viewerId());
  }

  protected approveBlocked(card: ApprovalCard): boolean {
    return !this.canApprove(card) || this.isBlocked(card);
  }

  protected denyBlocked(card: ApprovalCard): boolean {
    return !this.canDeny(card) || this.isBlocked(card);
  }

  protected readonly missingFieldReason = missingFieldReason;

  protected async decide(heldCard: ApprovalCard, decision: Decision, fromDrawer = false): Promise<void> {
    // A poll may have replaced the card after its click handler was created.
    const card = this.findCard(heldCard.approvalId);
    if (!card || !this.canStartDecision(card, decision)) return;
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
    if (decision === 'approved' && !this.canApprove(card)) return false;
    if (decision === 'rejected' && !this.canDeny(card)) return false;
    const state = this.localState(card);
    if (this.isBlocked(card) || card.state !== 'requested') return false;
    if (!state) return true;
    if (state.kind === 'step_up') return decision === 'rejected';
    return state.kind === 'not_recorded' || state.kind === 'conflict'
      || state.kind === 'still_open' || state.kind === 'conflict_still_open';
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
    this.setState(card.approvalId, { kind: 'recorded', decision });
    // Keep the accepted decision visible if the status read fails or shows an older state.
    this.announced.set(this.presentation.statusMessage(card));
    await this.read(conversationId, undefined, 'decision');
    this.announceDecision(this.findCard(card.approvalId));
    this.focus.focusIfTerminal(card.approvalId, fromDrawer, this.drawer(), this.drawer);
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
    const current = this.findCard(card.approvalId);
    if (current?.state === 'requested' && this.canDeny(current)) {
      this.setState(card.approvalId, { kind: 'conflict_still_open', decision });
    }
    this.announceDecision(current);
    this.focus.focusIfTerminal(card.approvalId, fromDrawer, this.drawer(), this.drawer);
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
    if (this.canDeny(current)) {
      this.setState(card.approvalId, { kind: 'not_recorded', decision });
      this.announced.set('Your decision was not recorded. You can decide again.');
      return;
    }
    this.setState(card.approvalId, { kind: 'not_decidable', decision });
  }

  private applyUnknownDecision(card: ApprovalCard, decision: Decision): void {
    if (this.findCard(card.approvalId)?.state !== 'requested') return;
    // Keep the decision locked until someone checks whether the server saved it.
    this.setState(card.approvalId, { kind: 'unknown', decision });
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
    if (this.busyChecks()[card.approvalId]) return;
    this.setCheckBusy(card.approvalId, true);
    try {
      await this.read(conversationId, undefined, 'check', card.approvalId);
      if (!isCurrentConversation(conversationId, this.conversationId(), conversationVersion,
        this.conversationVersion)) return;
      const updatedCard = this.findCard(card.approvalId);
      const updatedState = this.localStateById(card.approvalId);
      if (updatedCard?.state === 'outcome_unknown') {
        this.announced.set(this.presentation.resultMessage(updatedCard));
      }
      if (updatedCard?.state === 'approved') this.announced.set('Approved');
      if (updatedCard?.state === 'denied') this.announced.set('Denied');
      if (updatedState?.kind === 'still_open') {
        this.announced.set(this.presentation.statusMessage(updatedCard ?? card));
      }
    } finally {
      this.setCheckBusy(card.approvalId, false);
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
      this.focus.clearApprovalFocus();
      return;
    }
    if (drawer?.opener.isConnected) {
      drawer.opener.focus();
      return;
    }
    if (drawer && this.focus.terminalButton(drawer.approvalId)) {
      this.focus.terminalButton(drawer.approvalId)?.focus();
      return;
    }
    this.focus.requestTranscriptFocus();
  }

  protected checkDecisionStatus(card: ApprovalCard): void {
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
    purpose: ApprovalReadPurpose = 'poll',
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
        signal: approvalReadSignal(abortSignal, purpose),
      });
      await this.applyReadResponse(
        response, conversationId, version, abortSignal, purpose, checkingApprovalId,
      );
    } catch {
      if (!this.readIsCurrent(conversationId, version, abortSignal)) return;
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

  private shouldSkipPoll(purpose: ApprovalReadPurpose, activeCount: number): boolean {
    return purpose === 'poll' && activeCount > 0;
  }

  private async applyReadResponse(
    response: Response,
    conversationId: string,
    version: number,
    abortSignal: AbortSignal | undefined,
    purpose: ApprovalReadPurpose,
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
    purpose: ApprovalReadPurpose,
    checkingApprovalId: string | undefined,
  ): void {
    const firstRead = !this.loaded();
    const oldCards = this.cards();
    this.focus.focusFoldedFocusedCard(oldCards, result.cards);
    this.cards.set(result.cards);
    this.csrf = result.csrf;
    this.loaded.set(true);
    this.loading.set(false);
    this.readFailed.set(false);
    this.checkingAccess.set(false);
    if (result.cards.length > 0) this.hadCards.set(true);
    this.states.set(localStatesAfterRead(result.cards, this.states(), this.viewerId()));
    const message = newRequestAnnouncement(
      oldCards, result.cards, firstRead, this.announcedApprovalIds, this.viewerId(),
    );
    if (message) this.announced.set(message);
    this.followDrawer(result.cards);
    if (checkingApprovalId) this.finishCheckStatus(checkingApprovalId);
  }

  private finishCheckStatus(approvalId: string): void {
    const current = this.localStateById(approvalId);
    const checked = checkedState(current, this.findCard(approvalId));
    if (checked) this.setState(approvalId, checked);
  }

  private applyAccessChange(): void {
    const showNotice = this.hadCards();
    const focusedPendingCard = this.focus.focusedPendingCard();
    this.cards.set([]);
    this.csrf = '';
    this.states.set(statesDuringAccessCheck(this.states()));
    this.readFailed.set(false);
    this.checkingAccess.set(showNotice);
    this.loading.set(false);
    const drawer = this.drawer();
    this.drawer.set(undefined);
    if (drawer || focusedPendingCard) this.focus.requestTranscriptFocus();
    this.readVersion += 1;
  }

  private followDrawer(cards: ApprovalCard[]): void {
    const drawer = this.drawer();
    if (!drawer) return;
    if (findApprovalCard(cards, drawer.approvalId)) return;
    this.drawer.set(undefined);
    this.focus.requestTranscriptFocus();
  }

  private setCheckBusy(approvalId: string, busy: boolean): void {
    const nextChecks = { ...this.busyChecks(), [approvalId]: busy };
    this.busyChecks.set(nextChecks);
  }

  private emitWaitingOnViewer(): void {
    const waiting = hasApprovalWaitingOnViewer(
      this.cards(), this.states(), this.viewerId(), this.stoppedTurnIds(),
    );
    if (waiting === this.lastWaitingOnViewer) return;
    this.lastWaitingOnViewer = waiting;
    this.waitingOnViewer.emit(waiting);
  }

  protected isStopped(card: ApprovalCard): boolean {
    return Boolean(card.turnId && this.stoppedTurnIds().includes(card.turnId));
  }

  private clearWaitingOnViewer(): void {
    if (!this.lastWaitingOnViewer) return;
    this.lastWaitingOnViewer = false;
    this.waitingOnViewer.emit(false);
  }

  private findCard(approvalId: string): ApprovalCard | undefined {
    return findApprovalCard(this.cards(), approvalId);
  }

  private localStateById(approvalId: string): LocalState | undefined {
    return this.states()[approvalId];
  }

  private setState(approvalId: string, state: LocalState): void {
    const nextStates = { ...this.states(), [approvalId]: state };
    this.states.set(nextStates);
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
