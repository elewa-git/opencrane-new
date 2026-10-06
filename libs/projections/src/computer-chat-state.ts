export interface ComputerChatState {
  computerState: 'ready' | 'starting' | 'recovering';
  computerRecovered: boolean;
  computerLostAt: string | undefined;
}

export function lifecycleComputerState(lifecycle: { event: { type: string; time: string } }[],
  previous?: ComputerChatState): ComputerChatState {
  let computerState: 'ready' | 'starting' | 'recovering' = previous?.computerState ?? 'starting';
  let computerRecovered = previous?.computerRecovered ?? false;
  let computerLostAt = previous?.computerLostAt;
  for (const row of lifecycle) {
    if (row.event.type === 'computer.lost') {
      computerState = 'recovering';
      computerRecovered = false;
      computerLostAt = row.event.time;
      continue;
    }
    // Keep recovery visible during a replacement claim; only ready confirms recovery.
    if (row.event.type === 'computer.claimed') {
      if (computerState !== 'recovering') computerState = 'starting';
      computerRecovered = false;
      continue;
    }
    if (row.event.type === 'computer.ready') {
      computerRecovered = computerState === 'recovering';
      computerState = 'ready';
      continue;
    }
    if (row.event.type === 'computer.suspended' || row.event.type === 'computer.resumed') {
      if (computerState !== 'recovering') computerState = 'starting';
      computerRecovered = false;
      continue;
    }
    if (row.event.type === 'computer.retired') {
      computerState = 'starting';
      computerRecovered = false;
    }
  }
  return { computerState, computerRecovered, computerLostAt };
}
