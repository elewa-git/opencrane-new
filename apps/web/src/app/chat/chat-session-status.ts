import type { WritableSignal } from '@angular/core';
import type { ComputerState } from '@opencrane/protocol';

export function sessionWaitingReason(
  queued: boolean,
  active: boolean,
  computer: ComputerState,
  selected: boolean,
  connected: boolean,
  loading: boolean,
  historyFailure: boolean,
): string {
  if (queued) return 'queued';
  if (active && computer !== 'ready') return 'starting';
  if (selected && !connected && !loading && !historyFailure) return 'reconnecting';
  return '';
}

export function updateComputerStatus(
  computer: WritableSignal<ComputerState>,
  announcement: WritableSignal<string>,
  state: ComputerState,
): void {
  const previous = computer();
  computer.set(state);
  if (state === previous) return;
  if (state === 'recovering') {
    announcement.set('Your computer is recovering. Sending is paused.');
  } else if (previous === 'recovering' && state === 'ready') {
    announcement.set('Your computer is ready again. You can send.');
  }
}
