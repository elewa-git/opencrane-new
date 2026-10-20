import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { reportJournal, wireReport, type BridgeReport } from '../src/report-journal.ts';
import { nativeRequests } from '../src/native-requests.ts';
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
  function discovered() { return Promise.resolve(); }
  const driver: TurnDriver = { journal: `${directory}/reports`, rpc: transport,
    privateSession, grant, credential, catalogue, discovered };
  const runner = turnRunner(driver, journal, send, closeSocket);
  const frame = { id: 'turn', conversationId: 'chat', assistantId: 'assistant',
    text: 'Use a tool', token: 'token', expiresAt: Date.now() + 60_000, executionMode,
    tools: [{ key: 'oc_0123456789', serverId: 'fixture', connectionId: 'installed',
      definitions: [], modes: {} }] };
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
  function reloadAll() {
    const loaded = reportJournal(driver);
    loaded.load();
    return loaded.reports;
  }
  return { notify, finish, reload, reloadAll, close, reports, transport, runner };
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

async function reportsUnsupportedConsent() {
  const setup = await fixture();
  try {
    const request = { id: 17, method: 'mcpServer/elicitation/request', params: {
      threadId: 'thread', turnId: 'codex-turn', serverName: 'oc_0123456789',
      mode: 'form', message: 'Private consent text', requestedSchema: { secret: 'private' },
    } };
    const replies: unknown[] = [];
    function send(reply: unknown) { replies.push(reply); }
    const handle = nativeRequests(send, setup.runner.complete.bind(setup.runner));
    handle(request);
    handle(request);
    expect(replies).toEqual([{ id: 17, error: {
      code: -32601, message: 'Native consent is not supported',
    } }]);
    expect(setup.reports).toHaveLength(2);
    expect(setup.reports.at(-1)).toMatchObject({
      type: 'agent.native_consent_refused', nativeRequestId: '17',
      serverName: 'oc_0123456789', serverId: 'fixture', reason: 'unsupported_native_consent',
    });
    expect(JSON.stringify(setup.reports)).not.toContain('Private consent text');
    expect(JSON.stringify(setup.reports)).not.toContain('requestedSchema');
    const saved = setup.reloadAll();
    expect(saved.at(-1)).toEqual(setup.reports.at(-1));
  } finally {
    setup.close();
  }
}
it('reports unsupported native consent without saving its private request', reportsUnsupportedConsent);

async function reportsNativeRefusal(...test: string[]) {
  const [mode, method, requestKind, outcome] = test;

  const setup = await fixture(mode);
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write');
  try {
    const request = { id: 19, method, params: {
      threadId: 'thread', turnId: 'codex-turn', command: 'PRIVATE_NATIVE_MARKER',
    } };
    setup.runner.complete({ ...request, params: { ...request.params, turnId: 'wrong' } });
    setup.runner.complete({ ...request, params: { threadId: 'thread' } });
    expect(setup.reports).toHaveLength(1);
    const replies: unknown[] = [];
    function send(reply: unknown) { replies.push(reply); }
    const handle = nativeRequests(send, setup.runner.complete.bind(setup.runner));
    handle(request);
    handle(request);
    if (outcome === 'declined') expect(replies).toEqual([{ id: 19, result: { decision: 'decline' } }]);
    else expect(replies).toEqual([{ id: 19, error: {
      code: -32601, message: 'Native request is not supported',
    } }]);
    if (mode === 'memory_free') {
      expect(setup.reports.at(-1)).toMatchObject({ type: 'agent.native_request_refused',
        nativeRequestId: '19', requestKind, outcome });
      expect(setup.reloadAll().at(-1)).toEqual(setup.reports.at(-1));
      expect(JSON.stringify(setup.reloadAll())).not.toContain('PRIVATE_NATIVE_MARKER');
    } else expect(setup.reports).toHaveLength(1);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain('PRIVATE_NATIVE_MARKER');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('PRIVATE_NATIVE_MARKER');
    setup.finish();
    const count = setup.reports.length;
    setup.runner.complete(request);
    expect(setup.reports).toHaveLength(count);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    setup.close();
  }
}
const nativeCases = [
  ['memory_free', 'item/commandExecution/requestApproval', 'shell', 'declined'],
  ['memory_free', 'item/fileChange/requestApproval', 'file_change', 'declined'],
  ['memory_free', 'item/permissions/requestApproval', 'permissions', 'unsupported'],
  ['memory_free', 'item/tool/requestUserInput', 'user_input', 'unsupported'],
  ['memory_free', 'future/request', 'other', 'unsupported'],
  ['restricted', 'item/commandExecution/requestApproval', 'shell', 'declined'],
];
it.each(nativeCases)('records only matching running memory-free native requests: %s %s',
  reportsNativeRefusal);
