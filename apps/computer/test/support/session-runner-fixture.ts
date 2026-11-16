import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { reportJournal, type BridgeReport } from '../../src/report-journal.ts';
import { parseTurn } from '../../src/turn-frame.ts';
import { turnRunner, type TurnDriver } from '../../src/turn-runner.ts';

export function sessionRunnerFixture() {
  const directory = mkdtempSync(`${tmpdir()}/session-outcomes-`);
  const reports: BridgeReport[] = [];
  const sessions: { close: ReturnType<typeof vi.fn>; rpc: typeof rpc }[] = [];
  let nextThread = 0;
  function rpc(method: string, params: Record<string, unknown>) {
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: `thread-${++nextThread}`,
        ephemeral: true, path: null } });
    }
    return Promise.resolve({ turn: { id: `native-${String(params['threadId'])}` } });
  }
  function keepOpen() {}
  const lifetime = new Promise<void>(keepOpen);
  function privateSession() {
    const session = { rpc, close: vi.fn(), closed: lifetime };
    sessions.push(session);
    return Promise.resolve(session);
  }
  const grant = vi.fn().mockResolvedValue(undefined);
  function credential() { return { value: 'fixture', expiresAt: Date.now() + 60_000 }; }
  const driver: TurnDriver = { rpc, grant, privateSession, credential,
    journal: `${directory}/reports` };
  const journal = reportJournal(driver);
  const disconnected = vi.fn();
  function send(report: BridgeReport) {
    reports.push(report);
    function acknowledge() {
      runner.acknowledge(report.sequence, { token: 'fixture', expiresAt: Date.now() + 60_000 });
    }
    if (report.type === 'agent.turn_started') queueMicrotask(acknowledge);
  }
  const runner = turnRunner(driver, journal, send, disconnected);
  function input(id: string, executionMode = 'restricted') {
    return parseTurn({ id, conversationId: id, assistantId: 'assistant', executionMode,
      text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000 });
  }
  function finish(threadId = 'thread-1') {
    runner.complete({ method: 'turn/completed', params: {
      threadId, turn: { id: `native-${threadId}`, status: 'completed' },
    } });
  }
  function close() {
    runner.connectionLost();
    rmSync(directory, { recursive: true, force: true });
  }
  return { runner, driver, journal, reports, sessions, grant, disconnected, input, finish, close };
}
