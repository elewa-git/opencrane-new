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
    const response = { thread: { id: 'thread' }, turn: { id: 'codex-turn' } };
    return Promise.resolve(response);
  }
  let failOnRemoval = false;
  function modelFailed() {
    operations.push('model_failed');
    const terminal = { id: 'codex-turn', status: 'failed' };
    const params = { threadId: 'thread', turn: terminal };
    const notification = { method: 'turn/completed', params };
    runner.complete(notification);
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
    const display = { id: event.id, position: row.sequence,
      type: event.type, time: event.time, data };
    return chatRowSchema.parse(display);
  }
  try {
    keys.provision('test', 'chat');
    const create = { id: 'create', conversationId: 'chat', assistantId: 'assistant' };
    await chatCommand(nats.store, keys, person, create);
    const message = { id: 'message', conversationId: 'chat', text: 'Reply',
      executionMode: 'memory_free' };
    await chatCommand(nats.store, keys, person, message);
    const turn = { id: 'message', conversationId: 'chat', assistantId: 'assistant',
      requesterId: 'alice', executionMode: 'memory_free', text: 'Reply', token: 'initial',
      expiresAt: Date.now() + 60_000 };
    const input = parseTurn(turn);
    const starting = runner.start(input);
    await vi.waitFor(hasStartReport);
    expect(await recordReport(nats.store, keys, context, reports[0])).toBe('recorded');
    const grantReply = { token: 'fresh', expiresAt: Date.now() + 60_000 };
    runner.acknowledge(reports[0]!.sequence, grantReply);
    await starting;
    const partialReply = { method: 'item/agentMessage/delta', params: {
      threadId: 'thread', itemId: 'reply', delta: 'Partial reply before Stop',
    } };
    runner.complete(partialReply);
    expect(await recordReport(nats.store, keys, context, reports[1])).toBe('recorded');
    if (testCase.order === 'failure_then_stop') {
      modelFailed();
    }
    const stop = { id: 'stop', conversationId: 'chat', stopTurnId: 'message' };
    await chatCommand(nats.store, keys, person, stop);
    const beforeRestart = await chatHistory(nats.store, 'test', 'chat');
    const liveRows = beforeRestart.map(displayRow);
    const stoppingTranscript = transcript(liveRows, 'alice', 'message');
    expect(stoppingTranscript.at(-1)?.state).toBe('stopping');

    if (testCase.order === 'restart') {
      // Keep a crash separate when the computer never received Stop.
      const recovered = reportJournal(driver);
      recovered.load();
      turnRunner(driver, recovered, send, closeSocket);
    } else {
      // Reproduce a failed model stream while Stop is removing its connection.
      failOnRemoval = testCase.order === 'stop_then_failure';
      operations.push('stop_received');
      const interrupt = { turnId: 'message', conversationId: 'chat' };
      await runner.interrupt(interrupt);
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
    const expectedTurn = { state: testCase.state,
      text: 'Partial reply before Stop', reason: testCase.reason };
    const failedTools = [
      { label: 'Reply failed', detail: 'Run interrupted', failed: true },
    ];
    for (const turns of [live, reloadedTranscript]) {
      expect.soft(turns.at(-1)).toMatchObject(expectedTurn);
      if (testCase.state === 'stopped') {
        expect.soft(turns.at(-1)?.tools).toEqual([]);
      } else {
        expect.soft(turns.at(-1)?.tools).toMatchObject(failedTools);
      }
    }
    expect(failure.reason).toBe(testCase.reason);
  } finally {
    await nats.close();
    const cleanup = { recursive: true, force: true };
    await rm(directory, cleanup);
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
