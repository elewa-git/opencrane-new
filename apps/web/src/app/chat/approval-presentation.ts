import type { ApprovalCard } from '@opencrane/protocol';
import { utcDateTime } from './file-presentation';
import type { LocalState } from './approval-state';

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
    if (state.kind === 'step_up') {
      return 'Your sign-in is older than this approval allows. Signing in again doesn’t change '
        + 'what you’re approving.';
    }
    if (state.kind === 'unknown') return 'Decision not confirmed';
    if (state.kind === 'not_recorded') {
      return 'Your decision was not recorded. You can decide again.';
    }
    if (state.kind === 'not_decidable') return 'You can’t decide this approval.';
    if (state.kind === 'conflict') return 'This approval was already decided or is no longer open.';
    if (state.kind === 'still_open') {
      return `The server shows this approval still open. You can decide again. If it fails again, `
        + `the approval closes when its turn ends or at ${utcDateTime(card.expiresAt)}.`;
    }
    return '';
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
    if (card.state === 'outcome_unknown') return this.actorWords(card, 'Approved') + ' · used once';
    if (card.state === 'denied') return this.actorWords(card, 'Denied');
    if (card.state === 'expired') return 'Expired';
    if (card.state === 'cancelled') return 'Cancelled';
    return 'Approval needed';
  }

  terminalDetail(card: ApprovalCard): string {
    if (card.state === 'approved') return 'Not used yet';
    if (card.state === 'outcome_unknown') {
      return 'The call was allowed to go ahead once. It can’t be reused.';
    }
    if (card.state === 'expired') {
      return `${utcDateTime(card.expiresAt)} · nothing was sent with this approval`;
    }
    return 'Nothing was sent with this approval';
  }

  outcomeUnknown(card: ApprovalCard): boolean {
    return card.state === 'outcome_unknown';
  }

  lastExpired(card: ApprovalCard): boolean {
    const expiredCards = this.cards().filter(item => item.state === 'expired');
    const lastExpiredCard = expiredCards.at(-1);
    return lastExpiredCard?.approvalId === card.approvalId;
  }

  reference(card: ApprovalCard): string {
    return card.approvalId.slice(0, 12);
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
