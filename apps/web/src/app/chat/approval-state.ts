export type Decision = 'approved' | 'rejected';

export type LocalState =
  | { kind: 'submitting'; decision: Decision }
  | { kind: 'step_up'; decision: Decision }
  | { kind: 'unknown'; decision: Decision; repeated: boolean }
  | { kind: 'not_recorded'; decision: Decision }
  | { kind: 'not_decidable'; decision: Decision }
  | { kind: 'conflict'; decision: Decision }
  | { kind: 'still_open'; decision: Decision };

export function isTerminal(card: { state: string }): boolean {
  return card.state !== 'requested';
}

export function isRequested(card: { state: string }): boolean {
  return card.state === 'requested';
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
  if (card) return current;
  return undefined;
}

export function failedCheckState(current: LocalState | undefined): LocalState | undefined {
  if (current?.kind !== 'unknown') return undefined;
  return { ...current, repeated: true };
}

export function clearDecidedStates(
  states: Record<string, LocalState>,
  cards: Array<{ approvalId: string; state: string }>,
): Record<string, LocalState> {
  const next = { ...states };
  const cardIds = new Set(cards.map(card => card.approvalId));
  for (const card of cards) {
    if (card.state !== 'requested') delete next[card.approvalId];
  }
  for (const approvalId of Object.keys(next)) {
    if (!cardIds.has(approvalId)) delete next[approvalId];
  }
  return next;
}
