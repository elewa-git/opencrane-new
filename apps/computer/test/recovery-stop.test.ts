import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { chatRowSchema } from '@opencrane/protocol';
import { reportJournal, type BridgeReport } from '../src/report-journal.ts';
import { parseTurn, turnRunner } from '../src/turn-runner.ts';
import { chatCommand, chatHistory } from '../../server/src/chat/commands.ts';
import { chatDisplayData, hasDisplayText } from '../../server/src/chat/display.ts';
import { conversationKeys } from '../../server/src/chat/keys.ts';
import { recordReport } from '../../server/src/chat/reports.ts';
import { transcript } from '../../web/src/app/chat/chat-state.ts';

async function keepsRecoveryFailureAfterUndeliveredStop() {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/recovery-stop-`);
  const keys = conversationKeys(directory);
  const person = { silo: 'test', memberId: 'alice' };
  const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
  const reports: BridgeReport[] = [];
  const operations: string[] = [];
  function rpc(method: string) {
    operations.push(method);
    return Promise.resolve({ thread: { id: 'thread' }, turn: { id: 'codex-turn' } });
  }
  function grant() {
    return Promise.resolve();
  }
  function credential() {
    return { value: 'computer', expiresAt: Date.now() + 60_000 };
  }
  function send(report: BridgeReport) {
    reports.push(report);
  }
  function closeSocket() {
    throw new Error('Unexpected socket closure');
  }
  const driver = { journal: `${directory}/reports`, rpc, grant, credential };
  const journal = reportJournal(driver);
  const runner = turnRunner(driver, journal, send, closeSocket);
  function hasStartReport() {
    expect(reports).toHaveLength(1);
  }
  function displayRow(row: Awaited<ReturnType<typeof chatHistory>>[number]) {
    const event = row.event;
    const data = chatDisplayData(event.type, event.data);
    if (hasDisplayText(event.type)) {
      data.text = keys.decrypt('test', 'chat', event.data);
    }
    return chatRowSchema.parse({ id: event.id, position: row.sequence,
      type: event.type, time: event.time, data });
  }
  try {
    keys.provision('test', 'chat');
    await chatCommand(nats.store, keys, person,
      { id: 'create', conversationId: 'chat', assistantId: 'assistant' });
    await chatCommand(nats.store, keys, person,
      { id: 'message', conversationId: 'chat', text: 'Reply', executionMode: 'memory_free' });
    const input = parseTurn({ id: 'message', conversationId: 'chat', assistantId: 'assistant',
      requesterId: 'alice', executionMode: 'memory_free', text: 'Reply', token: 'initial',
      expiresAt: Date.now() + 60_000 });
    const starting = runner.start(input);
    await vi.waitFor(hasStartReport);
    expect(await recordReport(nats.store, keys, context, reports[0])).toBe('recorded');
    runner.acknowledge(reports[0]!.sequence,
      { token: 'fresh', expiresAt: Date.now() + 60_000 });
    await starting;
    runner.complete({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread', itemId: 'reply', delta: 'Partial reply before restart',
    } });
    expect(await recordReport(nats.store, keys, context, reports[1])).toBe('recorded');
    await chatCommand(nats.store, keys, person,
      { id: 'stop', conversationId: 'chat', stopTurnId: 'message' });
    const beforeRestart = await chatHistory(nats.store, 'test', 'chat');
    const liveRows = beforeRestart.map(displayRow);
    expect(transcript(liveRows, 'alice', 'message').at(-1)?.state).toBe('stopping');

    // Restart before delivering Stop. Recovery must explain the failure as a crash.
    const recovered = reportJournal(driver);
    recovered.load();
    turnRunner(driver, recovered, send, closeSocket);
    expect(operations).not.toContain('turn/interrupt');
    const reloaded = reportJournal(driver);
    reloaded.load();
    const replayed: BridgeReport[] = [];
    function replay(report: BridgeReport) {
      replayed.push(report);
    }
    reloaded.replay(reports[1]!.sequence, new Map(), replay);
    expect(replayed).toHaveLength(1);
    const failure = replayed[0]!;
    expect(await recordReport(nats.store, keys, context, failure)).toBe('recorded');
    expect(await recordReport(nats.store, keys, context, failure)).toBe('duplicate');
    const afterRestart = await chatHistory(nats.store, 'test', 'chat');
    const terminalRow = displayRow(afterRestart.at(-1)!);
    liveRows.push(terminalRow);
    const live = transcript(liveRows, 'alice', 'message');
    const reloadRows = afterRestart.map(displayRow);
    const reloadedTranscript = transcript(reloadRows, 'alice');
    expect(reloadedTranscript).toEqual(live);
    for (const turns of [live, reloadedTranscript]) {
      expect.soft(turns.at(-1)).toMatchObject({ state: 'failed',
        text: 'Partial reply before restart', reason: 'bridge_restarted',
        tools: [{ label: 'Reply failed', detail: 'Run interrupted', failed: true }] });
    }
    expect(failure.reason).toBe('bridge_restarted');
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it('keeps Reply failed and partial text live and after reload when recovery precedes Stop delivery',
  keepsRecoveryFailureAfterUndeliveredStop);
