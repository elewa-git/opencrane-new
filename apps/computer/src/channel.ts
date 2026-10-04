import type { Server } from 'node:http';
import { bridgeSocket, type BridgeSocketState } from './bridge-socket.ts';
import { reportJournal, type BridgeReport } from './report-journal.ts';
import { turnRunner, type TurnDriver } from './turn-runner.ts';

export type { BridgeReport } from './report-journal.ts';

/** Durable reports are sent in arrival order; each thread waits for its own start acknowledgement. */
export function bridgeChannel(server: Server, driver: TurnDriver) {
  const journal = reportJournal(driver);
  journal.load();

  const socketState: BridgeSocketState = { resumed: false };
  const socketMethods: { send?: (report: BridgeReport) => void } = {};

  function sendReport(report: BridgeReport) {
    const send = socketMethods.send;
    if (send) send(report);
  }

  function closeCurrentSocket(code: number, reason: string) {
    socketState.socket?.close(code, reason);
  }

  const runner = turnRunner(driver, journal, sendReport, closeCurrentSocket);

  function reportCount() {
    return journal.reports.length;
  }

  function replayReports(since: number, send: (report: BridgeReport) => void) {
    const waiting = runner.waiting;
    journal.replay(since, waiting, send);
  }

  const bridge = bridgeSocket(server, driver, socketState, runner, reportCount, replayReports);
  socketMethods.send = bridge.send;

  function notification(value: unknown) {
    runner.complete(value);
  }

  return { notification, close: bridge.close };
}
