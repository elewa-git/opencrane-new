import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { reportJournal, type BridgeReport } from '../src/report-journal.ts';
import { parseTurn, turnRunner, type TurnDriver } from '../src/turn-runner.ts';
import type { ToolServer } from '../src/turn-frame.ts';
import { record } from '../src/http.ts';
import { threadLoads } from '../src/thread-loads.ts';

const tools: ToolServer[] = [{ key: 'oc_0123456789', serverId: 'server', connectionId: 'installed',
  modes: { read: 'allow' as const },
  definitions: ['{"name":"read","inputSchema":{"type":"object"}}'] }];

function fixture() {
  const directory = mkdtempSync(`${tmpdir()}/thread-loads-`);
  const reports: BridgeReport[] = [];
  const operations: { method: string; params: Record<string, unknown> }[] = [];
  let staysLoaded = false;
  let refuseBinding = false;
  let missingDiscovery = false;
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
  function discovered(loadKey: string) {
    if (missingDiscovery) return Promise.reject(new Error('No discovery'));
    operations.push({ method: 'discovered', params: { loadKey } });
    return Promise.resolve();
  }
  const driver = { journal: `${directory}/reports`, rpc, grant, credential,
    catalogue, dropCatalogue, discovered } satisfies TurnDriver;
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
  function unstuck() { staysLoaded = false; }
  function refuseNextBinding() { refuseBinding = true; }
  function refuseDiscovery() { missingDiscovery = true; }
  function restart() { runner = turnRunner(driver, journal, send, closeSocket); }
  function close() { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); }
  return { start, finish, stuck, unstuck, refuseNextBinding, refuseDiscovery, restart, close, operations, reports,
    get runner() { return runner; } };
}

async function startsAndReloadsAfterCompletion() {
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
    const methods: string[] = [];
    for (const operation of test.operations.slice(previousCount)) methods.push(operation.method);
    expect(methods).toEqual(['thread/unsubscribe', 'thread/loaded/list', 'catalogue',
      'thread/resume', 'catalogue', 'discovered', 'turn/start']);
    expect(test.operations.at(-1)?.params).toEqual(expectedTurn);
  } finally { test.close(); }
}
function isThreadStart(operation: { method: string }) { return operation.method === 'thread/start'; }
it('registers before loading and releases the list when the turn finishes', startsAndReloadsAfterCompletion);

async function reloadsChangedList(empty: boolean) {
  const test = fixture();
  try {
    await test.start('first');
    test.finish();
    await test.start('busy', tools, 'chat-B');
    const previousCount = test.operations.length;
    let changed = [{ ...tools[0]!, definitions: ['{"name":"after"}'], modes: { after: 'allow' as const } }];
    if (empty) changed = [];
    await test.start('changed', changed);
    const operations = test.operations.slice(previousCount);
    const methods: string[] = [];
    for (const operation of operations) methods.push(operation.method);
    const expectedMethods = ['thread/unsubscribe', 'thread/loaded/list',
      'catalogue', 'thread/resume', 'catalogue'];
    if (!empty) expectedMethods.push('discovered');
    expectedMethods.push('turn/start');
    expect(methods).toEqual(expectedMethods);
    expect(operations[0]!.params).toEqual({ threadId: 'thread-chat-A' });
    const resumeConfig = operations[3]!.params['config'];
    expect(operations[3]!.params['threadId']).toBe('thread-chat-A');
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
    test.unstuck();
    const retryStart = test.operations.length;
    await test.start('next-after-stuck');
    const nextOperations = test.operations.slice(retryStart);
    expect(nextOperations[0]?.method).toBe('thread/unsubscribe');
    expect(nextOperations.find(isThreadResume)?.params['config']).toBeDefined();
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
    expect(operations[2]!.method).toBe('catalogue');
    expect(operations[3]).toMatchObject({ method: 'thread/resume', params: {
      threadId: 'thread-chat-A',
    } });
    expect(operations[3]!.params['config']).toBeDefined();
  } finally { test.close(); }
}
it('resumes with a fresh list and URL when the bridge has no remembered loads', resumesAfterRestart);

async function unloadsAfterIncompleteReload() {
  const test = fixture();
  try {
    await test.start('first');
    test.finish();
    test.refuseNextBinding();
    const otherTools = [{ ...tools[0]!, definitions: ['{"name":"other"}'], modes: { other: 'allow' as const } }];
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

async function refusesLateResume() {
  const operations: string[] = [];
  const discoveredKeys = new Set<string>();
  let activeKey = '';
  let lateKey = '';
  let resumeCount = 0;
  function catalogue(loadKey: string) {
    activeKey = loadKey;
    return Promise.resolve();
  }
  function dropCatalogue(loadKey: string) {
    discoveredKeys.delete(loadKey);
    return Promise.resolve();
  }
  function discovered(loadKey: string) {
    if (!discoveredKeys.has(loadKey)) return Promise.reject(new Error('No discovery'));
    return Promise.resolve();
  }
  function rpc(method: string) {
    operations.push(method);
    if (method === 'thread/loaded/list') return Promise.resolve({ data: [] });
    if (method === 'thread/unsubscribe') return Promise.resolve({ status: 'notLoaded' });
    if (method === 'thread/resume') {
      resumeCount += 1;
      if (resumeCount === 1) {
        lateKey = activeKey;
        return Promise.reject(new Error('Thread resume timed out after 30 seconds'));
      }
      if (resumeCount === 2) {
        // Finish the old resume first. Codex then rejoins it and ignores the new config.
        discoveredKeys.add(lateKey);
      } else discoveredKeys.add(activeKey);
      return Promise.resolve({ thread: { id: 'thread-chat-A' } });
    }
    return Promise.resolve({});
  }
  const driver = { rpc, catalogue, dropCatalogue, discovered };
  const loads = threadLoads(driver);
  const input = parseTurn({ id: 'failed', conversationId: 'chat-A', assistantId: 'assistant',
    text: 'Local turn', token: 'frame', expiresAt: Date.now() + 60_000, tools });
  await expect(loads.load(input, 'thread-chat-A', {})).rejects.toThrow();
  await expect(loads.load(input, 'thread-chat-A', {})).rejects.toThrow();
  const retryStart = operations.length;
  await loads.load(input, 'thread-chat-A', {});
  expect(operations.slice(retryStart)).toContain('thread/unsubscribe');
  expect(resumeCount).toBe(3);
}
it('refuses a new load ignored after a timed-out resume finishes late', refusesLateResume);

async function reportsMissingDiscovery() {
  const test = fixture();
  try {
    test.refuseDiscovery();
    const input = parseTurn({ id: 'missing', conversationId: 'chat-A', assistantId: 'assistant',
      text: 'Local turn', token: 'frame', expiresAt: Date.now() + 60_000, tools });
    await test.runner.start(input);
    expect(test.operations.some(isTurnStart)).toBe(false);
    expect(test.reports.at(-1)?.type).toBe('agent.turn_failed');
    expect(test.reports.find(isReloadMessage)?.text).toBe(
      'The tools for this conversation could not be reloaded. Send your message again.');
  } finally { test.close(); }
}
it('fails with the existing plain message before a turn whose list was not discovered',
  reportsMissingDiscovery);
