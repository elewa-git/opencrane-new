import type { WritableSignal } from '@angular/core';
import type { ApprovalCard } from '@opencrane/protocol';

export interface ApprovalDrawerState {
  approvalId: string;
  opener: HTMLElement;
  open: boolean;
  returnFocusTo?: HTMLElement;
}

export class ApprovalFocus {
  private readonly root: HTMLElement;
  private focusApprovalId = '';
  private closeDrawerForApprovalId = '';
  private focusTranscriptAfterRender = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  focusedPendingCard(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const pendingCards = this.root.querySelectorAll<HTMLElement>('.approval.pending');
    for (const card of pendingCards) {
      if (card.contains(active)) return true;
    }
    return false;
  }

  requestTranscriptFocus(): void {
    this.focusTranscriptAfterRender = true;
  }

  clearApprovalFocus(): void {
    this.focusApprovalId = '';
  }

  focusIfTerminal(
    approvalId: string,
    fromDrawer: boolean,
    drawer: ApprovalDrawerState | undefined,
    drawerSignal: WritableSignal<ApprovalDrawerState | undefined>,
  ): void {
    if (fromDrawer && drawer?.approvalId === approvalId) {
      const returnFocusTo = this.terminalButton(approvalId);
      this.focusApprovalId = approvalId;
      if (returnFocusTo) {
        drawerSignal.set({ ...drawer, open: false, returnFocusTo });
      } else {
        this.closeDrawerForApprovalId = approvalId;
        drawerSignal.set({ ...drawer });
      }
      return;
    }
    this.focusApprovalId = approvalId;
  }

  focusFoldedFocusedCard(oldCards: ApprovalCard[], newCards: ApprovalCard[]): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    let focusedCard: ApprovalCard | undefined;
    for (const card of oldCards) {
      const section = this.root.querySelector<HTMLElement>(
        `.approval.pending[data-approval="${card.approvalId}"]`,
      );
      if (section?.contains(active)) {
        focusedCard = card;
        break;
      }
    }
    if (!focusedCard) return;
    let updated: ApprovalCard | undefined;
    for (const card of newCards) {
      if (card.approvalId === focusedCard.approvalId) updated = card;
    }
    if (!updated) {
      this.requestTranscriptFocus();
      return;
    }
    if (updated.state === 'requested') return;
    this.focusApprovalId = focusedCard.approvalId;
  }

  restoreFocus(
    drawer: ApprovalDrawerState | undefined,
    drawerSignal: WritableSignal<ApprovalDrawerState | undefined>,
  ): void {
    if (this.closeDrawerForApprovalId) {
      this.closeDrawerAfterDecisionRender(drawer, drawerSignal);
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

  terminalButton(approvalId: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(
      `oc-approval-terminal-line [data-approval="${approvalId}"]`,
    );
  }

  private closeDrawerAfterDecisionRender(
    drawer: ApprovalDrawerState | undefined,
    drawerSignal: WritableSignal<ApprovalDrawerState | undefined>,
  ): void {
    const approvalId = this.closeDrawerForApprovalId;
    this.closeDrawerForApprovalId = '';
    const returnFocusTo = this.terminalButton(approvalId);
    if (!drawer || drawer.approvalId !== approvalId || !returnFocusTo) {
      drawerSignal.set(undefined);
      this.focusApprovalId = approvalId;
      return;
    }
    drawerSignal.set({ ...drawer, open: false, returnFocusTo });
  }

  private focusTranscript(): void {
    const transcript = this.root.closest<HTMLElement>('.transcript');
    transcript?.focus();
  }
}
