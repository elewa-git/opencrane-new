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
  return undefined;
}

export function keepStateAfterRead(state: LocalState): boolean {
  // Keep writes and uncertain decisions locked while the server view catches up.
  return state.kind === 'submitting' || state.kind === 'recorded'
    || state.kind === 'unknown' || state.kind === 'step_up'
    || state.kind === 'still_open' || state.kind === 'conflict_still_open';
}

export function conflictStateAfterRead(
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
