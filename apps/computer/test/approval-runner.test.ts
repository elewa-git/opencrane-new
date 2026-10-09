import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { turnRunner, type TurnDriver } from '../src/turn-runner.ts';
import { reportJournal, type BridgeReport } from '../src/report-journal.ts';

async function renewsAndStops() {
  const directory = mkdtempSync(`${tmpdir()}/approval-runner-`);
  const operations: string[] = [];
  const reports: BridgeReport[] = [];
  function rpc(method: string) {
    operations.push(method);
    return Promise.resolve({ thread: { id: 'thread' }, turn: { id: 'codex-turn' } });
  }
  function grant() { operations.push('grant'); return Promise.resolve(); }
  function credential() { return { value: 'computer', expiresAt: Date.now() + 60_000 }; }
  function endHolds() { operations.push('endHolds'); }
  const driver: TurnDriver = { rpc, grant, credential, journal: `${directory}/reports` };
  const journal = reportJournal(driver);
  let renewAck = true;
  function send(report: BridgeReport) {
    reports.push(report);
    function acknowledge() {
      runner.acknowledge(report.sequence, { token: 'fresh', expiresAt: Date.now() + 60_000 });
    }
    if (renewAck) queueMicrotask(acknowledge);
  }
  function close() {}
  const signal = vi.fn();
  const runner = turnRunner(driver, journal, send, close, signal, { endThread: endHolds });
  try {
    const turn = { id: 'turn', conversationId: 'chat', assistantId: 'assistant',
      executionMode: 'memory_free' as const, text: 'Use tool', token: 'initial',
      expiresAt: Date.now() + 60_000, taskKind: 'chat_turn', omittedAttachments: 0 };
    await runner.start(turn);
    expect(runner.approvalWaiting('other', 'a'.repeat(64))).toBe(false);
    expect(runner.approvalWaiting('thread', 'a'.repeat(64))).toBe(true);
    expect(signal).toHaveBeenCalledWith({ type: 'approval_waiting', approvalId: 'a'.repeat(64),
      conversationId: 'chat', turnId: 'turn' });
    await Promise.all([runner.renew('thread'), runner.renew('thread')]);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
    expect(operations.at(-1)).toBe('grant');
    renewAck = false;
    vi.useFakeTimers();
    const unavailable = runner.renew('thread');
    const refused = expect(unavailable).rejects.toThrow('No new turn pass');
    await vi.advanceTimersByTimeAsync(10_001);
    await refused;
    vi.useRealTimers();
    await runner.interrupt({ turnId: 'turn', conversationId: 'chat' });
    expect(operations.slice(-2)).toEqual(['endHolds', 'turn/interrupt']);
    await expect(runner.renew('thread')).rejects.toThrow('Turn ended');
    runner.complete({ method: 'turn/completed', params: { threadId: 'thread',
      turn: { status: 'completed' } } });
    expect(operations.slice(-2)).toEqual(['endHolds', 'grant']);
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
}
it('renews the same start, times out missing tokens, and releases holds before Stop and release',
  renewsAndStops);
