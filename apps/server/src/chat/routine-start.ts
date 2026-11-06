import type { WebSocket } from 'ws';
import type { turnCommand } from './turns.ts';
import { ReportRejected } from './reports.ts';

type Check = NonNullable<Parameters<typeof turnCommand>[1]['routineStart']>;
type Pending = { check: Check | undefined; complete: (accepted: boolean) => void };

// Keep completion on the original connection. Saved admission cannot recreate this wait.
export function pendingRoutineStarts(socket: WebSocket) {
  const starts = new Map<string, Pending>();
  function bind(turnId: string, check: Check, signal?: AbortSignal) {
    if (starts.has(turnId)) {
      throw new ReportRejected('Routine sender already bound');
    }
    const result = Promise.withResolvers<boolean>();
    const deadline = performance.now() + 10_000;
    const timer = setTimeout(cancel, 10_000);
    const pending: Pending = { check, complete };
    starts.set(turnId, pending);
    function complete(accepted: boolean) {
      const current = performance.now() < deadline && !signal?.aborted
        && socket.readyState === socket.OPEN;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (starts.get(turnId) === pending) {
        starts.delete(turnId);
      }
      result.resolve(accepted && current);
    }
    function cancel() {
      complete(false);
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted || socket.readyState !== socket.OPEN) {
      cancel();
    }
    return { pending: result.promise, cancel };
  }
  async function check(report: Parameters<Check>[0]) {
    const pending = starts.get(report.turnId);
    const check = pending?.check;
    if (!pending || !check) {
      throw new ReportRejected('Routine start unavailable');
    }
    pending.check = undefined;
    return check(report);
  }
  function complete(report: { type: string; turnId: string },
    acknowledgement: { token?: string; refused?: string }, duplicate: boolean) {
    if (report.type !== 'agent.turn_started') {
      return;
    }
    const pending = starts.get(report.turnId);
    const accepted = acknowledgement.token !== undefined && acknowledgement.refused === undefined
      && !duplicate && pending?.check === undefined;
    pending?.complete(accepted);
  }
  function close() {
    for (const pending of starts.values()) {
      pending.complete(false);
    }
  }
  socket.once('close', close);
  return { bind, check, complete };
}
