import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { reportJournal, wireReport, type BridgeReport } from '../src/report-journal.ts';
import { parseTurn, turnRunner, type TurnDriver } from '../src/turn-runner.ts';

async function fixture(executionMode = 'memory_free') {
  const directory = mkdtempSync(`${tmpdir()}/tool-runner-`);
  const journal = reportJournal({ journal: `${directory}/reports` });
  const reports: BridgeReport[] = [];
  function rpc(method: string) {
    if (method.startsWith('thread/')) {
      return Promise.resolve({ thread: { id: 'thread', ephemeral: true, path: null } });
    }
    return Promise.resolve({ turn: { id: 'codex-turn' } });
  }
  const transport = vi.fn(rpc);
  function privateSession() {
    function close() {}
    function remainOpen() {}
    const closed = new Promise<void>(remainOpen);
    return Promise.resolve({ rpc: transport, close, closed });
  }
  function grant() { return Promise.resolve(); }
  function credential() { return { value: 'computer', expiresAt: Date.now() + 60_000 }; }
  function send(report: BridgeReport) { reports.push(wireReport(report)); }
  function closeSocket() { throw new Error('Unexpected socket closure'); }
  function catalogue() { return Promise.resolve(); }
  const driver: TurnDriver = { journal: `${directory}/reports`, rpc: transport,
    privateSession, grant, credential, catalogue };
  const runner = turnRunner(driver, journal, send, closeSocket);
  const frame = { id: 'turn', conversationId: 'chat', assistantId: 'assistant',
    text: 'Use a tool', token: 'token', expiresAt: Date.now() + 60_000, executionMode,
    tools: [{ key: 'oc_0123456789', serverId: 'fixture', connectionId: 'installed',
      definitions: [] }] };
  const starting = runner.start(parseTurn(frame));
  function hasStarted() { expect(reports).toHaveLength(1); }
  await vi.waitFor(hasStarted);
  runner.acknowledge(1, { token: 'grant', expiresAt: Date.now() + 60_000 });
  await starting;
  function notify(method: string, item: unknown) {
    runner.complete({ method, params: { threadId: 'thread', item } });
  }
  function finish() {
    runner.complete({ method: 'turn/completed',
      params: { threadId: 'thread', turn: { status: 'completed' } } });
  }
  function reload() {
    const loaded = reportJournal(driver);
    loaded.load();
    return loaded.reports.filter(isToolReport);
  }
  function close() { finish(); rmSync(directory, { recursive: true, force: true }); }
  return { notify, finish, reload, close, reports, transport };
}
function isToolReport(report: BridgeReport) {
  return report.type === 'agent.tool_call_started' || report.type === 'agent.tool_call_finished';
}

async function reportsToolProgress(status: string) {
  const test = await fixture();
  try {
    const item = { type: 'mcpToolCall', id: 'call_1', server: 'oc_0123456789', tool: 'write',
      arguments: { private: 'arguments' }, result: 'private result', error: 'private error',
      status, durationMs: 75 };
    test.notify('item/started', item);
    test.notify('item/completed', item);
    test.notify('item/started', { ...item, server: 'unknown' });
    test.notify('item/completed', { ...item, server: 'unknown' });
    const toolReports = test.reports.filter(isToolReport);
    let expectedStatus = 'failed';
    if (status === 'completed') expectedStatus = 'completed';
    const common = { conversationId: 'chat', assistantId: 'assistant', turnId: 'turn',
      callId: 'call_1', serverId: 'fixture', toolName: 'write' };
    expect(toolReports).toEqual([
      { ...common, type: 'agent.tool_call_started', sequence: 2, previousSequence: 1 },
      { ...common, type: 'agent.tool_call_finished', sequence: 3, previousSequence: 2,
        status: expectedStatus, durationMs: 75 },
    ]);
    expect(test.reload()).toEqual(toolReports);
  } finally { test.close(); }
}
it.each(['completed', 'failed', 'cancelled'])(
  'reports %s tool progress without private data and keeps it after journal reload', reportsToolProgress);

async function refusesPrivateTools() {
  const test = await fixture('restricted');
  try {
    const item = { type: 'mcpToolCall', id: 'call_1', server: 'oc_0123456789', tool: 'write' };
    test.notify('item/started', item);
    test.notify('item/completed', item);
    test.finish();
    expect(test.reports.filter(isToolReport)).toEqual([]);
    expect(test.transport).toHaveBeenCalledWith('turn/interrupt',
      { threadId: 'thread', turnId: 'codex-turn' });
    expect(test.reports.at(-1)).toMatchObject({ type: 'agent.turn_failed',
      reason: 'restricted_tool_refused' });
  } finally { test.close(); }
}
it('still refuses tool calls in private turns', refusesPrivateTools);

async function ignoresInvalidToolReport(fields: Record<string, unknown>) {
  const test = await fixture();
  try {
    const item = { type: 'mcpToolCall', id: 'call_1', server: 'oc_0123456789', tool: 'write',
      ...fields };
    test.notify('item/started', item);
    test.notify('item/completed', item);
    const valid = { ...item, id: 'functions.write:0', tool: 'write', status: 'completed' };
    test.notify('item/started', valid);
    test.notify('item/completed', valid);
    test.finish();
    expect(test.reports).toMatchObject([
      { sequence: 1, type: 'agent.turn_started' },
      { sequence: 2, previousSequence: 1, type: 'agent.tool_call_started',
        callId: 'functions.write:0' },
      { sequence: 3, previousSequence: 2, type: 'agent.tool_call_finished' },
      { sequence: 4, previousSequence: 3, type: 'agent.turn_completed' },
    ]);
    expect(test.reload()).toHaveLength(2);
  } finally {
    test.close();
  }
}
const invalidToolFields = [
  { id: '' }, { id: 'x'.repeat(201) }, { id: 'call\n1' },
  { tool: '' }, { tool: 'x'.repeat(201) }, { tool: 'write\n' },
];
it.each(invalidToolFields)(
  'skips invalid tool fields %j and continues reporting without sequence gaps',
  ignoresInvalidToolReport);

async function ignoresToolNotificationsAfterTurnCompletion() {
  const test = await fixture();
  try {
    test.finish();
    const item = { type: 'mcpToolCall', id: 'late_call', server: 'oc_0123456789', tool: 'write',
      status: 'completed' };
    test.notify('item/started', item);
    test.notify('item/completed', item);
    expect(test.reports).toMatchObject([
      { sequence: 1, type: 'agent.turn_started' },
      { sequence: 2, previousSequence: 1, type: 'agent.turn_completed' },
    ]);
    expect(test.reports.filter(isToolReport)).toEqual([]);
    expect(test.reload()).toEqual([]);
  } finally {
    test.close();
  }
}
it('ignores tool starts and finishes received after the turn completes',
  ignoresToolNotificationsAfterTurnCompletion);
