import type { WebSocket } from 'ws';
import type { ChatOptions } from './routes.ts';
import { bridgeControl } from './bridge-control.ts';
import { recoverBudgetRefusals } from './budget-refusal.ts';
import { requireWakeLive, type WakeControl } from './bridge-opening.ts';
import { reportPosition } from './reports.ts';

type ResumeOptions = Pick<ChatOptions, 'silo' | 'store'>;
type ResumeInput = { computerId: string; assistantId: string };

export async function resumeBridgeReports(options: ResumeOptions, input: ResumeInput,
  socket: WebSocket, control: ReturnType<typeof bridgeControl>,
  recoverRoutines: () => Promise<void>, wakeControl?: WakeControl) {
  function pollControl() {
    void control.send();
  }
  // Check this socket while setup is still reading reports. The watcher takes over afterwards.
  const timer = setInterval(pollControl, 250);
  function stopPolling() {
    clearInterval(timer);
  }
  socket.once('close', stopPolling);
  try {
    requireWakeLive(wakeControl);
    await control.send();
    requireWakeLive(wakeControl);
    await recoverBudgetRefusals(options.store, options.silo, input.assistantId, wakeControl);
    requireWakeLive(wakeControl);
    await recoverRoutines();
    requireWakeLive(wakeControl);
    const position = await reportPosition(options.store, options.silo, input.computerId);
    requireWakeLive(wakeControl);
    await control.send();
    requireWakeLive(wakeControl);
    const resume = { type: 'resume', since: position, approvalWaiting: true };
    socket.send(JSON.stringify(resume));
  } finally {
    stopPolling();
    socket.off('close', stopPolling);
  }
}
