import type { WebSocket } from 'ws';
import type { turnCommand } from './turns.ts';
import { ReportRejected } from './reports.ts';

type Check = NonNullable<Parameters<typeof turnCommand>[1]['routineStart']>;
type Pending = { check: Check | undefined; cancel: () => void;
  send: (deliver: () => void) => Promise<boolean> };
type OwnershipCheck = (deadline: number) => Promise<boolean>;

// Keep completion on the original connection. Saved admission cannot recreate this wait.
export function pendingRoutineStarts(socket: WebSocket) {
  const starts = new Map<string, Pending>();
  function bind(turnId: string, check: Check, checkCurrent: OwnershipCheck, signal?: AbortSignal) {
    if (starts.has(turnId)) {
      throw new ReportRejected('Routine sender already bound');
    }
    const result = Promise.withResolvers<boolean>();
    const deadline = performance.now() + 10_000;
    const timer = setTimeout(cancel, 10_000);
    let settled = false;
    const pending: Pending = { check, cancel, send };
    starts.set(turnId, pending);
    function current() {
      return !settled && starts.get(turnId) === pending && performance.now() < deadline
        && !signal?.aborted && socket.readyState === socket.OPEN;
    }
    function consume() {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (starts.get(turnId) === pending) {
        starts.delete(turnId);
      }
    }
    function cancel() {
      if (settled) {
        return;
      }
      consume();
      result.resolve(false);
    }
    async function send(deliver: () => void) {
      try {
        if (!current() || !await checkCurrent(deadline) || !current()) {
          cancel();
          return false;
        }
        // Consume before sending, without yielding. Cancellation can no longer win.
        consume();
        deliver();
        result.resolve(true);
        return true;
      } catch (error) {
        consume();
        result.resolve(false);
        throw error;
      }
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
  async function send(report: { turnId: string },
    acknowledgement: { token?: string; refused?: string }, duplicate: boolean,
    deliver: () => void) {
    const pending = starts.get(report.turnId);
    const accepted = acknowledgement.token !== undefined && acknowledgement.refused === undefined
      && !duplicate && pending?.check === undefined;
    if (!pending || !accepted) {
      pending?.cancel();
      return false;
    }
    return pending.send(deliver);
  }
  function close() {
    for (const pending of starts.values()) {
      pending.cancel();
    }
  }
  socket.once('close', close);
  return { bind, check, send };
}
