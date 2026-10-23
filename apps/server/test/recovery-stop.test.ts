import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { chatRowSchema } from '@opencrane/protocol';
import { reportJournal, type BridgeReport } from '../../computer/test/server.ts';
import { parseTurn, turnRunner } from '../../computer/test/server.ts';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { chatDisplayData, hasDisplayText } from '../src/chat/display.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';
import { transcript } from '../../web/test/chat-state.ts';

interface StopOrderCase {
  order: 'restart' | 'stop_then_failure' | 'failure_then_stop';
  reason: string;
  state: 'failed' | 'stopped';
}

async function keepsTerminalOutcome(testCase: StopOrderCase) {
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
  let failOnRemoval = false;
  function modelFailed() {
    operations.push('model_failed');
    runner.complete({ method: 'turn/completed', params: {
      threadId: 'thread', turn: { id: 'codex-turn', status: 'failed' },
    } });
  }
  function grant(_thread: string, _conversation: string, token: string) {
    if (!token && failOnRemoval) {
      failOnRemoval = false;
      operations.push('access_removed');
      modelFailed();
    }
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
    const displayData = chatDisplayData(event.type, event.data);
    let data: unknown = displayData;
    if (hasDisplayText(event.type)) {
      data = { ...displayData, text: keys.decrypt('test', 'chat', event.data) };
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
      threadId: 'thread', itemId: 'reply', delta: 'Partial reply before Stop',
    } });
    expect(await recordReport(nats.store, keys, context, reports[1])).toBe('recorded');
    if (testCase.order === 'failure_then_stop') modelFailed();
    await chatCommand(nats.store, keys, person,
      { id: 'stop', conversationId: 'chat', stopTurnId: 'message' });
    const beforeRestart = await chatHistory(nats.store, 'test', 'chat');
    const liveRows = beforeRestart.map(displayRow);
    expect(transcript(liveRows, 'alice', 'message').at(-1)?.state).toBe('stopping');

    if (testCase.order === 'restart') {
      // Keep a crash separate when the computer never received Stop.
      const recovered = reportJournal(driver);
      recovered.load();
      turnRunner(driver, recovered, send, closeSocket);
    } else {
      // Reproduce a failed model stream while Stop is removing its connection.
      failOnRemoval = testCase.order === 'stop_then_failure';
      operations.push('stop_received');
      await runner.interrupt({ turnId: 'message', conversationId: 'chat' });
      let ending = ['model_failed', 'stop_received'];
      if (testCase.order === 'stop_then_failure') {
        ending = ['stop_received', 'access_removed', 'model_failed'];
      }
      expect(operations.slice(-ending.length)).toEqual(ending);
    }
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
      expect.soft(turns.at(-1)).toMatchObject({ state: testCase.state,
        text: 'Partial reply before Stop', reason: testCase.reason });
      if (testCase.state === 'stopped') {
        expect.soft(turns.at(-1)?.tools).toEqual([]);
      } else {
        expect.soft(turns.at(-1)?.tools).toMatchObject([
          { label: 'Reply failed', detail: 'Run interrupted', failed: true },
        ]);
      }
    }
    expect(failure.reason).toBe(testCase.reason);
  } finally {
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const stopOrderCases: StopOrderCase[] = [
  { order: 'restart', reason: 'bridge_restarted', state: 'failed' },
  { order: 'stop_then_failure', reason: 'stop_interrupted', state: 'stopped' },
  { order: 'failure_then_stop', reason: 'model_error', state: 'failed' },
];

it.each(stopOrderCases)(
  'keeps the first terminal cause live and after reload: $order', keepsTerminalOutcome,
);
