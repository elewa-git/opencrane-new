import { expect, it, vi } from 'vitest';
import { threadLoads } from '../src/thread-loads.ts';
import { approvalHolds } from '../src/approval-holds.ts';
import { mcpProxy } from '../src/mcp-proxy.ts';
import { parseTurn, type ToolServer } from '../src/turn-frame.ts';

const tools: ToolServer[] = [{ key: 'oc_0123456789', serverId: 'server',
  connectionId: 'installed', definitions: ['{"name":"read"}'], modes: { read: 'allow' } }];

function fixture() {
  function waiting() { return false; }
  async function renew() {}
  const holds = approvalHolds({ waiting, renew });
  const proxy = mcpProxy('http://127.0.0.1:1', new Map(), holds);
  const operations: string[] = [];
  let conversation = '';
  let failBinding = false;
  let failDrop = false;
  let wrongThread = false;
  function catalogue(loadKey: string, chat: string, list: ToolServer[],
    thread: string | undefined, turnId: string) {
    conversation = chat;
    const lastOperation = operations.at(-1);
    if (thread && failBinding
      && (lastOperation === 'thread/start' || lastOperation === 'thread/resume')) {
      return Promise.reject(new Error('Binding failed'));
    }
    proxy.catalogue({ loadKey, turnId, conversation: chat, tools: list, thread });
    return Promise.resolve();
  }
  function dropCatalogue(loadKey: string) {
    if (failDrop) return Promise.reject(new Error('Control socket unavailable'));
    proxy.drop({ loadKey });
    return Promise.resolve();
  }
  function discovered() { return Promise.resolve(); }
  function rpc(method: string, params: Record<string, unknown>) {
    operations.push(method);
    if (method === 'thread/loaded/list') return Promise.resolve({ data: [] });
    if (method === 'thread/unsubscribe') return Promise.resolve({ status: 'unsubscribed' });
    const id = wrongThread ? 'wrong-thread' : params['threadId'] ?? `thread-${conversation}`;
    return Promise.resolve({ thread: { id } });
  }
  const driver = { catalogue, dropCatalogue, discovered, rpc };
  const loads = threadLoads(driver);
  function turn(chat: string) {
    return parseTurn({ id: chat, conversationId: chat, assistantId: 'assistant',
      text: 'Local turn', token: 'token', expiresAt: Date.now() + 60_000, tools });
  }
  function refuseBinding() { failBinding = true; }
  function refuseDrop() { failDrop = true; }
  function mismatch() { wrongThread = true; }
  return { proxy, loads, turn, operations, refuseBinding, refuseDrop, mismatch };
}

async function prunesFinishedLoads() {
  const test = fixture();
  for (let index = 0; index < 200; index++) {
    const chat = `chat-${index}`;
    await test.loads.load(test.turn(chat), undefined, {});
    expect(test.loads.size).toBe(1);
    expect(test.proxy.size).toBe(1);
    expect(test.proxy.currentSize).toBe(1);
    await test.loads.forget(`thread-${chat}`);
    expect(test.loads.size).toBe(0);
    expect(test.proxy.size).toBe(0);
    expect(test.proxy.currentSize).toBe(0);
  }
}
it('releases all per-load state over many finished conversations', prunesFinishedLoads);

async function prunesFailedDrops() {
  vi.useFakeTimers();
  try {
    const test = fixture();
    test.refuseDrop();
    for (let index = 0; index < 64; index++) {
      const chat = `chat-${index}`;
      await test.loads.load(test.turn(chat), undefined, {});
      await expect(test.loads.forget(`thread-${chat}`)).rejects.toThrow('Control socket');
      expect(test.loads.size).toBe(0);
    }
    await expect(test.loads.load(test.turn('overflow'), undefined, {})).rejects.toThrow();
    expect(test.proxy.size).toBe(64);
    expect(test.proxy.currentSize).toBe(64);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(test.proxy.size).toBe(0);
    expect(test.proxy.currentSize).toBe(0);
  } finally { vi.useRealTimers(); }
}
it('forgets local loads and expires remote lists after failed drops', prunesFailedDrops);

async function unloadsOrphan() {
  const test = fixture();
  test.refuseBinding();
  await expect(test.loads.load(test.turn('orphan'), undefined, {})).rejects.toThrow();
  expect(test.operations).toEqual(['thread/start', 'thread/unsubscribe', 'thread/loaded/list']);
  expect(test.loads.size).toBe(0);
  expect(test.proxy.size).toBe(0);
  expect(test.proxy.currentSize).toBe(0);
}
it('unsubscribes a started thread when its catalogue binding fails', unloadsOrphan);

async function refusesWrongResume(changed: boolean) {
  const test = fixture();
  await test.loads.load(test.turn('chat'), undefined, {});
  test.mismatch();
  const input = test.turn('chat');
  if (changed) input.tools = [];
  await expect(test.loads.load(input, 'thread-chat', {})).rejects.toThrow();
  expect(test.loads.size).toBe(0);
  expect(test.proxy.size).toBe(0);
  expect(test.operations).not.toContain('turn/start');
}
it.each([false, true])('refuses a resumed thread with another id (changed: %s)',
  refusesWrongResume);

async function forgetsBeforeStuckUnload() {
  const operations: string[] = [];
  let stuck = false;
  let clock = Date.now();
  function now() { return clock; }
  const time = vi.spyOn(Date, 'now').mockImplementation(now);
  function rpc(method: string) {
    operations.push(method);
    if (method === 'thread/loaded/list') {
      if (stuck) {
        clock += 10_001;
        return Promise.resolve({ data: ['thread-chat'] });
      }
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ thread: { id: 'thread-chat' } });
  }
  function catalogue() { return Promise.resolve(); }
  function dropCatalogue() { return Promise.resolve(); }
  function discovered() { return Promise.resolve(); }
  const driver = { rpc, catalogue, dropCatalogue, discovered };
  const loads = threadLoads(driver);
  const base = fixture();
  try {
    const original = base.turn('chat');
    await loads.load(original, undefined, {});
    const changed = { ...original, tools: [] };
    stuck = true;
    await expect(loads.load(changed, 'thread-chat', {})).rejects.toThrow();
    expect(loads.size).toBe(0);
    stuck = false;
    const retryStart = operations.length;
    await loads.load(original, 'thread-chat', {});
    expect(operations.slice(retryStart)).toEqual(['thread/unsubscribe',
      'thread/loaded/list', 'thread/resume']);
    await loads.forget('thread-chat');
  } finally { time.mockRestore(); }
}
it('drops the fingerprint before a stuck unload and reloads the original list next time',
  forgetsBeforeStuckUnload);

async function prunesAfterFailedBindingAndDrop() {
  vi.useFakeTimers();
  try {
    const test = fixture();
    test.refuseBinding();
    test.refuseDrop();
    await expect(test.loads.load(test.turn('chat'), 'thread-chat', {})).rejects.toThrow();
    expect(test.loads.size).toBe(0);
    expect(test.proxy.size).toBe(1);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(test.proxy.size).toBe(0);
    expect(test.proxy.currentSize).toBe(0);
  } finally { vi.useRealTimers(); }
}
it('keeps no confirmed load when both resume binding and catalogue drop fail',
  prunesAfterFailedBindingAndDrop);

async function keepsSiblingHolds() {
  vi.useFakeTimers();
  try {
    function waiting() { return true; }
    function renew() { return Promise.resolve(); }
    function answer() {}
    const holds = approvalHolds({ waiting, renew });
    const local = mcpProxy('http://unused', new Map(), holds);
    const loadKey = 'a'.repeat(32);
    local.catalogue({ loadKey, turnId: 'turn', conversation: 'chat', thread: 'thread', tools });
    holds.resume(true);
    holds.add({ approvalId: 'a'.repeat(64), thread: 'thread', send: renew, answer });
    local.extendThread('thread', Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(local.size).toBe(1);
    local.dropThread('thread', 'turn');
    expect(local.size).toBe(0);
  } finally { vi.useRealTimers(); }
}
it('keeps the tool list while another approval in that thread still waits', keepsSiblingHolds);
