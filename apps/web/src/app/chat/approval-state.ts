import type { ApprovalCard } from '@opencrane/protocol';

export type Decision = 'approved' | 'rejected';

export type LocalState =
  | { kind: 'submitting'; decision: Decision }
  | { kind: 'recorded'; decision: Decision }
  | { kind: 'step_up'; decision: Decision }
  | { kind: 'unknown'; decision: Decision }
  | { kind: 'not_recorded'; decision: Decision }
  | { kind: 'not_decidable'; decision: Decision }
  | { kind: 'conflict'; decision: Decision }
  | { kind: 'still_open'; decision: Decision }
  | { kind: 'conflict_still_open'; decision: Decision };

function isTerminal(card: { state: string }): boolean {
  return card.state !== 'requested';
}

function isRequested(card: { state: string }): boolean {
  return card.state === 'requested';
}

export function orderedApprovalCards(cards: ApprovalCard[]): ApprovalCard[] {
  const terminal = cards.filter(isTerminal);
  const pending = cards.filter(isRequested);
  return [...terminal, ...pending];
}

export function findApprovalCard(cards: ApprovalCard[], approvalId: string): ApprovalCard | undefined {
  for (const card of cards) {
    if (card.approvalId === approvalId) return card;
  }
  return undefined;
}

export function missingFieldReason(card: ApprovalCard): string {
  const names = card.missingFields ?? [];
  return `Approve is unavailable. Missing reviewed fields: ${names.join(', ')}. `
    + 'Ask the assistant again with these details.';
}

export function canDenyCard(card: ApprovalCard, viewerId: string): boolean {
  return card.requesterId === viewerId && (card.canDeny ?? card.canDecide);
}

export function localStatesAfterRead(
  cards: ApprovalCard[],
  currentStates: Record<string, LocalState>,
  viewerId: string,
): Record<string, LocalState> {
  const nextStates: Record<string, LocalState> = {};
  for (const card of cards) {
    const state = currentStates[card.approvalId];
    if (card.state !== 'requested' || !state) continue;
    if (state.kind === 'conflict') {
      nextStates[card.approvalId] = conflictStateAfterRead(
        canDenyCard(card, viewerId), state.decision,
      );
      continue;
    }
    if (keepStateAfterRead(state)) nextStates[card.approvalId] = state;
  }
  return nextStates;
}

export function newRequestAnnouncement(
  oldCards: ApprovalCard[],
  cards: ApprovalCard[],
  firstRead: boolean,
  announcedIds: Set<string>,
  viewerId: string,
): string | undefined {
  for (const card of oldCards) announcedIds.add(card.approvalId);
  if (firstRead) {
    for (const card of cards) announcedIds.add(card.approvalId);
    return undefined;
  }
  for (const card of cards) {
    if (card.state !== 'requested' || !canDenyCard(card, viewerId)) continue;
    if (announcedIds.has(card.approvalId)) continue;
    announcedIds.add(card.approvalId);
    return `Approval needed: ${card.review.action}`;
  }
  return undefined;
}

export function hasApprovalWaitingOnViewer(
  cards: ApprovalCard[],
  states: Record<string, LocalState>,
  viewerId: string,
  stoppedTurnIds: string[],
): boolean {
  for (const card of cards) {
    if (card.state !== 'requested' || !canDenyCard(card, viewerId)) continue;
    if (card.turnId && stoppedTurnIds.includes(card.turnId)) continue;
    const state = states[card.approvalId];
    if (state?.kind === 'submitting' || state?.kind === 'recorded'
      || state?.kind === 'unknown' || state?.kind === 'conflict') continue;
    return true;
  }
  return false;
}

export function isCurrentRead(
  conversationId: string,
  currentConversationId: string,
  version: number,
  currentVersion: number,
  abortSignal?: AbortSignal,
): boolean {
  return conversationId === currentConversationId && version === currentVersion
    && !abortSignal?.aborted;
}

export function isCurrentConversation(
  conversationId: string,
  currentConversationId: string,
  version: number,
  currentVersion: number,
): boolean {
  return conversationId === currentConversationId && version === currentVersion;
}

export function checkedState(
  current: LocalState | undefined,
  card: { state: string } | undefined,
): LocalState | undefined {
  if (current?.kind !== 'unknown') return undefined;
  if (card?.state === 'requested') {
    return { kind: 'still_open', decision: current.decision };
  }
  return undefined;
}

function keepStateAfterRead(state: LocalState): boolean {
  // Keep changes locked until the server confirms the latest decision status.
  return state.kind === 'submitting' || state.kind === 'recorded'
    || state.kind === 'unknown' || state.kind === 'step_up'
    || state.kind === 'still_open' || state.kind === 'conflict_still_open';
}

function conflictStateAfterRead(
  canDecide: boolean,
  decision: Decision,
): LocalState {
  if (canDecide) return { kind: 'conflict_still_open', decision };
  return { kind: 'not_decidable', decision };
}

export function statesDuringAccessCheck(
  states: Record<string, LocalState>,
): Record<string, LocalState> {
  const retained: Record<string, LocalState> = {};
  for (const [approvalId, state] of Object.entries(states)) {
    if (state.kind === 'submitting' || state.kind === 'unknown'
      || state.kind === 'conflict') {
      retained[approvalId] = state;
    }
  }
  return retained;
}
