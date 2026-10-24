import type { ApprovalCard } from '@opencrane/protocol';
import { utcDateTime } from './file-presentation';
import type { LocalState } from './approval-state';
import {
  approvalTimeRows, terminalDetail, terminalUseWords, terminalWords, type ApprovalTimeRow,
} from './approval-terminal-words';

export class ApprovalPresentation {
  private readonly viewerId: () => string;
  private readonly conversationId: () => string;
  private readonly localState: (card: ApprovalCard) => LocalState | undefined;
  private readonly cards: () => ApprovalCard[];

  constructor(
    viewerId: () => string,
    conversationId: () => string,
    localState: (card: ApprovalCard) => LocalState | undefined,
    cards: () => ApprovalCard[],
  ) {
    this.viewerId = viewerId;
    this.conversationId = conversationId;
    this.localState = localState;
    this.cards = cards;
  }

  statusMessage(card: ApprovalCard): string {
    const state = this.localState(card);
    if (!state) return '';
    if (state.kind === 'submitting') {
      return state.decision === 'approved' ? 'Sending your approval…' : 'Sending your denial…';
    }
    if (state.kind === 'recorded') {
      return 'Your decision was recorded. Waiting for the latest status.';
    }
    if (state.kind === 'step_up') {
      return 'Your sign-in is older than this approval allows. Signing in again doesn’t change '
        + 'what you’re approving.';
    }
    if (state.kind === 'unknown') return 'Decision not confirmed';
    if (state.kind === 'not_recorded') {
      return 'Your decision was not recorded. You can decide again.';
    }
    if (state.kind === 'not_decidable') return 'You can’t decide this approval.';
    if (state.kind === 'conflict') {
      return 'The server did not confirm whether this approval is still open. Check its status.';
    }
    if (state.kind === 'conflict_still_open') {
      return 'The server did not record your decision. The approval is still open. You can decide again.';
    }
    if (state.kind === 'still_open') {
      return `The server shows this approval still open. You can decide again. If it fails again, `
        + `the approval closes when its turn ends or at ${utcDateTime(card.expiresAt)}.`;
    }
    return '';
  }

  headerMessage(card: ApprovalCard): string {
    const state = this.localState(card);
    if (state?.kind === 'submitting') return this.statusMessage(card);
    if (state?.kind === 'recorded') return 'Decision recorded';
    return 'Approval needed';
  }

  signIn(card: ApprovalCard): string {
    const returnTo = `/workspace?conversation=${this.conversationId()}`;
    return `/auth/login?approval=${card.approvalId}&returnTo=${encodeURIComponent(returnTo)}`;
  }

  drawerDescription(card: ApprovalCard): string {
    const requester = card.requesterId === this.viewerId() ? 'you' : 'another participant';
    return `Requested by ${requester} · expires ${utcDateTime(card.expiresAt)}`;
  }

  stateWords(card: ApprovalCard): string {
    if (card.state === 'approved') return this.actorWords(card, 'Approved');
    if (card.state === 'outcome_unknown') {
      return `${this.actorWords(card, 'Approved')} · ${terminalUseWords(card)}`;
    }
    if (card.state === 'denied') return this.actorWords(card, 'Denied');
    if (card.state === 'expired') return 'Expired';
    if (card.state === 'cancelled') return terminalWords(card) ?? 'Cancelled';
    return 'Approval needed';
  }

  resultMessage(card: ApprovalCard): string {
    if (card.toolReplied) return 'Done: the tool replied';
    return 'Result not confirmed';
  }

  terminalDetail(card: ApprovalCard): string {
    return terminalDetail(card);
  }

  times(card: ApprovalCard): ApprovalTimeRow[] {
    return approvalTimeRows(card);
  }

  lastExpired(card: ApprovalCard): boolean {
    const expiredCards = this.cards().filter(item => item.state === 'expired');
    const lastExpiredCard = expiredCards.at(-1);
    return lastExpiredCard?.approvalId === card.approvalId;
  }

  reference(card: ApprovalCard): string {
    return card.approvalId;
  }

  decisionAnnouncement(card: ApprovalCard | undefined): string {
    if (card?.state === 'approved') return 'Approved';
    if (card?.state === 'denied') return 'Denied';
    return '';
  }

  private actorWords(card: ApprovalCard, verb: string): string {
    if (card.requesterId === this.viewerId()) return `${verb} by you`;
    return `${verb} by the requester`;
  }
}
