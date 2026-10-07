import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { reportJournal, type BridgeReport } from '../src/report-journal.ts';
import { parseTurn, turnRunner, type TurnDriver } from '../src/turn-runner.ts';
import { record } from '../src/http.ts';

const tools = [{ key: 'oc_0123456789', serverId: 'server', connectionId: 'installed',
  definitions: ['{"name":"read","inputSchema":{"type":"object"}}'] }];

function fixture() {
  const directory = mkdtempSync(`${tmpdir()}/thread-loads-`);
  const reports: BridgeReport[] = [];
  const operations: { method: string; params: Record<string, unknown> }[] = [];
  let staysLoaded = false;
  let refuseBinding = false;
  function rpc(method: string, params: Record<string, unknown>) {
    operations.push({ method, params });
    if (method === 'thread/loaded/list') {
      return Promise.resolve({ data: staysLoaded ? ['thread-chat-A', 'thread-chat-B'] : ['thread-chat-B'] });
    }
    if (method === 'thread/unsubscribe') return Promise.resolve({ status: 'unsubscribed' });
    if (method === 'thread/start') {
      let threadId = 'thread-chat-A';
      if (operations.some(isThreadBLoad)) threadId = 'thread-chat-B';
      return Promise.resolve({ thread: { id: threadId } });
    }
    if (method === 'thread/resume') return Promise.resolve({ thread: { id: params['threadId'] } });
    return Promise.resolve({ turn: { id: 'codex-turn' } });
  }
  function isThreadBLoad(operation: typeof operations[number]) {
    return operation.method === 'catalogue' && operation.params['conversation'] === 'chat-B';
  }
  function grant() { return Promise.resolve(); }
  function credential() { return { value: 'computer', expiresAt: Date.now() + 60_000 }; }
  function catalogue(loadKey: string, conversation: string, list: unknown, thread?: string) {
    operations.push({ method: 'catalogue', params: { loadKey, conversation, tools: list, thread } });
    const previous = operations.at(-2);
    if (refuseBinding && thread && previous?.method === 'thread/resume') {
      refuseBinding = false;
      return Promise.reject(new Error('Binding reply lost'));
    }
    return Promise.resolve();
  }
  function dropCatalogue(loadKey: string) {
    operations.push({ method: 'dropCatalogue', params: { loadKey } });
    return Promise.resolve();
  }
  const driver = { journal: `${directory}/reports`, rpc, grant, credential,
    catalogue, dropCatalogue } satisfies TurnDriver;
  const journal = reportJournal(driver);
  function send(report: BridgeReport) { reports.push(report); }
  function closeSocket() { throw new Error('Unexpected socket closure'); }
  let runner = turnRunner(driver, journal, send, closeSocket);
  async function start(id: string, list = tools, conversation = 'chat-A') {
    const frame = { id, conversationId: conversation, assistantId: 'assistant',
      requesterId: 'alice', text: 'Local turn', token: 'frame', expiresAt: Date.now() + 60_000,
      tools: list };
    const input = parseTurn(frame);
    const started = runner.start(input);
    function awaitingGrant() { expect(runner.waiting.size).toBe(1); }
    await vi.waitFor(awaitingGrant);
    const sequence = [...runner.waiting.keys()][0]!;
    runner.acknowledge(sequence, { token: 'grant', expiresAt: Date.now() + 60_000 });
    await started;
  }
  function finish(conversation = 'chat-A') {
    runner.complete({ method: 'turn/completed', params: { threadId: `thread-${conversation}`,
      turn: { status: 'completed' } } });
  }
  function stuck() { staysLoaded = true; }
  function refuseNextBinding() { refuseBinding = true; }
  function restart() { runner = turnRunner(driver, journal, send, closeSocket); }
  function close() { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); }
  return { start, finish, stuck, refuseNextBinding, restart, close, operations, reports,
    get runner() { return runner; } };
}

async function startsAndRejoins() {
  const test = fixture();
  try {
    await test.start('first');
    expect(test.operations[0]).toMatchObject({ method: 'catalogue',
      params: { conversation: 'chat-A', tools } });
    const loadKey = test.operations[0]!.params['loadKey'];
    expect(loadKey).toMatch(/^[a-f0-9]{32}$/u);
    const start = test.operations.find(isThreadStart)!;
    expect(start.params).toMatchObject({ config: { mcp_servers: {
      oc_0123456789: { url: `http://127.0.0.1:8080/mcp/${String(loadKey)}/oc_0123456789`,
        bearer_token_env_var: 'PROXY_CALLER_TOKEN' },
    } } });
    test.finish();
    const previousCount = test.operations.length;
    await test.start('same');
    const expectedTurn: unknown = expect.objectContaining({ threadId: 'thread-chat-A' });
    expect(test.operations.slice(previousCount)).toEqual([
      { method: 'thread/resume', params: { threadId: 'thread-chat-A' } },
      { method: 'turn/start', params: expectedTurn },
    ]);
  } finally { test.close(); }
}
function isThreadStart(operation: { method: string }) { return operation.method === 'thread/start'; }
it('registers before loading and rejoins an unchanged list without replacing its URL', startsAndRejoins);

async function reloadsChangedList(empty: boolean) {
  const test = fixture();
  try {
    await test.start('first');
    test.finish();
    await test.start('busy', tools, 'chat-B');
    const previousCount = test.operations.length;
    let changed = [{ ...tools[0]!, definitions: ['{"name":"after"}'] }];
    if (empty) changed = [];
    await test.start('changed', changed);
    const operations = test.operations.slice(previousCount);
    const methods: string[] = [];
    for (const operation of operations) methods.push(operation.method);
    expect(methods).toEqual(['thread/unsubscribe', 'thread/loaded/list', 'dropCatalogue',
      'catalogue', 'thread/resume', 'catalogue', 'turn/start']);
    expect(operations[0]!.params).toEqual({ threadId: 'thread-chat-A' });
    const resumeConfig = operations[4]!.params['config'];
    expect(operations[4]!.params['threadId']).toBe('thread-chat-A');
    if (empty) expect(resumeConfig).toEqual({ mcp_servers: {} });
    else {
      const config = record(resumeConfig);
      const servers = record(config['mcp_servers']);
      expect(servers['oc_0123456789']).toBeDefined();
    }
    for (const operation of operations) {
      expect(operation.params['threadId']).not.toBe('thread-chat-B');
    }
  } finally { test.close(); }
}
it.each([false, true])('reloads only A when its list changes (empty: %s) while B runs', reloadsChangedList);

async function failsUnconfirmedReload() {
  const test = fixture();
  try {
    await test.start('first');
    test.finish();
    test.stuck();
    const previousCount = test.operations.length;
    const changed = parseTurn({ id: 'changed', conversationId: 'chat-A', assistantId: 'assistant',
      requesterId: 'alice', text: 'No tool', token: 'frame', expiresAt: Date.now() + 60_000 });
    await test.runner.start(changed);
    const operations = test.operations.slice(previousCount);
    expect(operations.some(isTurnStart)).toBe(false);
    expect(test.reports.at(-1)).toMatchObject({ type: 'agent.turn_failed' });
    const message = test.reports.find(isReloadMessage);
    expect(message?.text).toBe('The tools for this conversation could not be reloaded. Send your message again.');
  } finally { test.close(); }
}
function isTurnStart(operation: { method: string }) { return operation.method === 'turn/start'; }
function isReloadMessage(report: BridgeReport) {
  return report.type === 'agent.message_completed' && report.text?.includes('could not be reloaded');
}
it('fails with plain text and never starts a turn when unload is not confirmed',
  failsUnconfirmedReload, 15_000);

async function resumesAfterRestart() {
  const test = fixture();
  try {
    await test.start('first');
    test.finish();
    test.restart();
    const previousCount = test.operations.length;
    await test.start('next');
    const operations = test.operations.slice(previousCount);
    expect(operations[0]!.method).toBe('catalogue');
    expect(operations[1]).toMatchObject({ method: 'thread/resume', params: {
      threadId: 'thread-chat-A',
    } });
    expect(operations[1]!.params['config']).toBeDefined();
  } finally { test.close(); }
}
it('resumes with a fresh list and URL when the bridge has no remembered loads', resumesAfterRestart);

async function unloadsAfterIncompleteReload() {
  const test = fixture();
  try {
    await test.start('first');
    test.finish();
    test.refuseNextBinding();
    const otherTools = [{ ...tools[0]!, definitions: ['{"name":"other"}'] }];
    const failed = parseTurn({ id: 'failed', conversationId: 'chat-A', assistantId: 'assistant',
      requesterId: 'alice', text: 'Changed tools', token: 'frame',
      expiresAt: Date.now() + 60_000, tools: otherTools });
    await test.runner.start(failed);
    expect(test.reports.at(-1)).toMatchObject({ type: 'agent.turn_failed' });
    const previousCount = test.operations.length;
    await test.start('retry', []);
    const operations = test.operations.slice(previousCount);
    expect(operations[0]).toEqual({ method: 'thread/unsubscribe',
      params: { threadId: 'thread-chat-A' } });
    expect(operations[1]!.method).toBe('thread/loaded/list');
    const resume = operations.find(isThreadResume)!;
    expect(resume.params).toMatchObject({ config: { mcp_servers: {} } });
  } finally { test.close(); }
}
function isThreadResume(operation: { method: string }) {
  return operation.method === 'thread/resume';
}
it('unloads a partly loaded thread before retrying with another list', unloadsAfterIncompleteReload);
