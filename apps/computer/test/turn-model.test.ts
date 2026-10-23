import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { reportJournal, wireReport, type BridgeReport } from '../src/report-journal.ts';
import { turnRunner, type TurnDriver } from '../src/turn-runner.ts';

function modelFixture(initialModel: unknown, executionMode: 'restricted' | 'memory_free'
  = 'memory_free') {
  const directory = mkdtempSync(`${tmpdir()}/turn-model-`);
  const calls: Record<string, unknown>[] = [];
  const grants: string[] = [];
  const reports: BridgeReport[] = [];
  let model = initialModel;
  function rpc(method: string, params: Record<string, unknown>) {
    if (method === 'turn/start') {
      calls.push(params);
    }
    return Promise.resolve({ thread: { id: 'thread', ephemeral: true, path: null },
      turn: { id: 'codex-turn' } });
  }
  function grant(_thread: string, _conversation: string, token: string) {
    if (token) {
      grants.push(token);
    }
    return Promise.resolve();
  }
  function credential() {
    return { value: 'computer', expiresAt: Date.now() + 60_000 };
  }
  function close() {}
  function send(report: BridgeReport) {
    reports.push(report);
    function acknowledge() {
      const reply = { token: 'fresh', expiresAt: Date.now() + 60_000, model };
      runner.acknowledge(report.sequence, reply);
    }
    if (report.type === 'agent.turn_started') {
      queueMicrotask(acknowledge);
    }
  }
  function keepSessionOpen() {}
  const closed = new Promise<void>(keepSessionOpen);
  function privateSession() {
    return Promise.resolve({ rpc, close, closed });
  }
  const driver: TurnDriver = { rpc, grant, credential, privateSession,
    journal: `${directory}/reports` };
  const journal = reportJournal(driver);
  const runner = turnRunner(driver, journal, send, close);
  const input = {
    id: 'turn', conversationId: 'chat', assistantId: 'assistant',
    executionMode, text: 'Hello', token: 'initial',
    expiresAt: Date.now() + 60_000, taskKind: 'chat_turn', omittedAttachments: 0,
  };
  function setModel(next: unknown) {
    model = next;
  }
  function finish() {
    runner.complete({ method: 'turn/completed', params: {
      threadId: 'thread', turn: { status: 'completed' },
    } });
    rmSync(directory, { recursive: true, force: true });
  }
  return { runner, input, calls, grants, reports, setModel, finish, driver };
}

async function refusesInvalidModel(model: unknown) {
  const test = modelFixture(model);
  try {
    await test.runner.start(test.input);
    expect(test.calls).toHaveLength(0);
    expect(test.grants).toHaveLength(0);
    expect(test.reports.at(-1)?.type).toBe('agent.turn_failed');
  } finally {
    test.finish();
  }
}
it.each(['', null, 42, {}, 'x'.repeat(201), 'model\nother'])(
  'refuses an invalid acknowledged model %j before granting or executing', refusesInvalidModel);

async function refusesChangedRenewal(model: unknown) {
  const test = modelFixture('gpt-6-luna');
  try {
    await test.runner.start(test.input);
    expect(test.calls[0]).toMatchObject({ model: 'gpt-6-luna' });
    test.setModel(model);
    await expect(test.runner.renew('thread')).rejects.toThrow('Turn model changed');
    expect(test.grants).toHaveLength(1);
    expect(test.calls).toHaveLength(1);
    test.setModel('gpt-6-luna');
    await test.runner.renew('thread');
    expect(test.grants).toHaveLength(2);
    expect(test.calls).toHaveLength(1);
  } finally {
    test.finish();
  }
}
it.each(['gpt-6.1-sol', undefined])(
  'refuses a renewed model %j that differs from the running turn', refusesChangedRenewal);

async function keepsLegacyTaskModel() {
  const test = modelFixture(undefined);
  try {
    await test.runner.start(test.input);
    expect(test.calls[0]).toMatchObject({ model: 'gpt-6.1-sol' });
    await test.runner.renew('thread');
    expect(test.grants).toHaveLength(2);
    expect(test.calls).toHaveLength(1);
  } finally {
    test.finish();
  }
}
it('keeps task-table selection and renewal when an older server omits the model',
  keepsLegacyTaskModel);

async function doesNotRepeatAnAdmittedSharedTurnAfterRestart() {
  const directory = mkdtempSync(`${tmpdir()}/shared-turn-restart-`);
  const journalPath = `${directory}/reports`;
  const firstJournal = reportJournal({ journal: journalPath });
  firstJournal.append({ id: 'turn', conversationId: 'child', assistantId: 'assistant',
    executionMode: 'restricted', sharingClass: 'shared_only' }, 'agent.turn_started', {
    threadId: 'thread',
  });
  const reopenedJournal = reportJournal({ journal: journalPath });
  reopenedJournal.load();
  const calls: string[] = [];
  const reports: BridgeReport[] = [];
  function rpc(method: string) {
    calls.push(method);
    return Promise.resolve({});
  }
  function grant() {
    return Promise.resolve();
  }
  function credential() {
    return { value: 'computer', expiresAt: Date.now() + 60_000 };
  }
  function closeSocket() {}
  const driver: TurnDriver = {
    rpc,
    grant,
    credential,
    journal: journalPath,
  };
  function send(report: BridgeReport) {
    reports.push(report);
  }
  const runner = turnRunner(driver, reopenedJournal, send, closeSocket);
  const input = {
    id: 'turn', conversationId: 'child', assistantId: 'assistant', requesterId: 'bob',
    executionMode: 'restricted' as const, sharingClass: 'shared_only' as const,
    text: 'new child turn', token: 'token', expiresAt: Date.now() + 60_000,
    taskKind: 'chat_turn', omittedAttachments: 0,
  };

  try {
    expect(reopenedJournal.reports[0]?.sharingClass).toBe('shared_only');
    expect(reopenedJournal.reports).toMatchObject([
      { type: 'agent.turn_started', turnId: 'turn' },
      { type: 'agent.turn_failed', turnId: 'turn' },
    ]);
    reopenedJournal.replay(0, new Map(), send);
    expect(reports).toMatchObject([
      { type: 'agent.turn_started', sharingClass: 'shared_only' },
      { type: 'agent.turn_failed' },
    ]);
    await runner.start(input);
    expect(calls).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it('fails an admitted shared turn on restart without dispatching it again',
  doesNotRepeatAnAdmittedSharedTurnAfterRestart);

function keepsSharedOutputThread() {
  const directory = mkdtempSync(`${tmpdir()}/shared-output-thread-`);
  try {
    const journal = reportJournal({ journal: `${directory}/reports` });
    const input = { id: 'turn', conversationId: 'child', assistantId: 'assistant',
      executionMode: 'restricted' as const, sharingClass: 'shared_only' as const };
    journal.append(input, 'agent.turn_started', { threadId: 'shared-thread' });
    const output = journal.append(input, 'agent.message_completed',
      { messageId: 'reply', text: 'Shared answer' });
    expect(output.threadId).toBe('shared-thread');
    const reopened = reportJournal({ journal: `${directory}/reports` });
    reopened.load();
    expect(reopened.reports[1]?.threadId).toBe('shared-thread');
    expect(wireReport(reopened.reports[1]!)).toMatchObject({
      type: 'agent.output_lost', threadId: 'shared-thread',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it('keeps the admitted thread on shared output and lost-output recovery', keepsSharedOutputThread);

interface TerminalReasonCase {
  stop: boolean;
  status: string;
  refusedTool: boolean;
  reason: string;
}

const terminalReasonCases: TerminalReasonCase[] = [
  { stop: true, status: 'interrupted', refusedTool: false, reason: 'stop_interrupted' },
  { stop: true, status: 'failed', refusedTool: false, reason: 'stop_interrupted' },
  { stop: false, status: 'interrupted', refusedTool: false, reason: 'model_error' },
  { stop: true, status: 'interrupted', refusedTool: true, reason: 'restricted_tool_refused' },
];

async function recordsTerminalReason(testCase: TerminalReasonCase) {
  let executionMode: 'restricted' | 'memory_free' = 'memory_free';
  if (testCase.refusedTool) executionMode = 'restricted';
  const test = modelFixture('gpt-6-luna', executionMode);
  try {
    await test.runner.start(test.input);
    if (testCase.stop) {
      await test.runner.interrupt({ turnId: 'turn', conversationId: 'chat' });
    }
    if (testCase.refusedTool) {
      test.runner.complete({ method: 'item/started', params: {
        threadId: 'thread', item: { type: 'commandExecution' },
      } });
    }
    test.runner.complete({ method: 'turn/completed', params: {
      threadId: 'thread', turn: { id: 'codex-turn', status: testCase.status },
    } });
    const terminal = test.reports.at(-1)!;
    expect(terminal).toMatchObject({ type: 'agent.turn_failed', reason: testCase.reason });
    const reopened = reportJournal(test.driver);
    reopened.load();
    const replayed: BridgeReport[] = [];
    function send(report: BridgeReport) {
      replayed.push(report);
    }
    reopened.replay(0, new Map(), send);
    expect(replayed.at(-1)).toEqual(terminal);
  } finally {
    test.finish();
  }
}

it.each(terminalReasonCases)(
  'saves and replays the terminal cause: $status, Stop=$stop, refusal=$refusedTool',
  recordsTerminalReason,
);

async function explainsExecutionModeMismatch() {
  const test = modelFixture('gpt-6-luna');
  try {
    const journal = reportJournal(test.driver);
    journal.append(test.input, 'agent.turn_started', { threadId: 'thread' });
    const input = { ...test.input, executionMode: 'restricted' as const };
    function closeSocket() {}
    function send(report: BridgeReport) {
      test.reports.push(report);
    }
    const runner = turnRunner(test.driver, journal, send, closeSocket);
    await runner.start(input);
    expect(test.calls).toEqual([]);
    expect(test.reports.at(-1)).toMatchObject({ type: 'agent.turn_failed', reason: 'model_error' });
  } finally {
    test.finish();
  }
}

it('gives an execution-mode mismatch an explicit failure reason before running',
  explainsExecutionModeMismatch);
