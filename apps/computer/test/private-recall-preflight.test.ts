import { expect, it, vi } from 'vitest';
import { preflightFixture } from './private-recall-preflight-fixture.ts';

vi.mock('node:net', { spy: true });

async function permitsLoaderDiscovery() {
  const test = await preflightFixture();
  try {
    const { session } = await test.open();
    await session.rpc('thread/start', {});
    await expect(session.rpc('config/mcpServer/reload', {})).resolves.toEqual({});
    const params = { threadId: 'returned-native-1' };
    await expect(session.rpc('mcpServerStatus/list', params)).resolves.toEqual({});
    await expect(session.rpc('thread/loaded/list', {})).resolves.toEqual({ data: [] });
    expect(test.received).toEqual(['initialize', 'thread/start',
      'config/mcpServer/reload', 'mcpServerStatus/list', 'thread/loaded/list']);
  } finally {
    await test.close();
  }
}
it('keeps the admitted private session open for native tool discovery', permitsLoaderDiscovery);

async function loadsOnReturnedThread() {
  const test = await preflightFixture();
  try {
    const first = await test.prepare();
    await expect(first.load()).resolves.toHaveProperty('thread.id', first.binding.grant.thread);
    const second = await test.prepare('second');
    await second.load();
    expect(test.mcp.size).toBe(2);
    await test.loads.cancel(first.input.id);
    expect(test.mcp.size).toBe(1);
    expect(test.callers.identify(`Bearer ${first.owner.caller}`)).toBeUndefined();
    expect(test.callers.identify(`Bearer ${second.owner.caller}`)).toBe('second');
    function isStart(method: string) { return method === 'thread/start'; }
    expect(test.received.filter(isStart)).toHaveLength(2);
    expect(test.received).not.toContain('turn/start');
    expect(test.received).not.toContain('thread/resume');
  } finally {
    await test.close();
  }
}
it('loads recall on each returned thread and removes only its own catalogue', loadsOnReturnedThread);

const refusedRequests = [
  { method: 'config/mcpServer/reload', params: { threadId: 'other' } },
  { method: 'config/mcpServer/reload', params: { config: {} } },
  { method: 'thread/loaded/list', params: { cursor: 'other' } },
  { method: 'mcpServerStatus/list', params: {} },
  { method: 'mcpServerStatus/list', params: { threadId: 'other' } },
  { method: 'turn/start', params: { threadId: 'other' } },
  { method: 'thread/start', params: { threadId: 'returned-native-1' } },
];
async function refusesOtherRequests(request: typeof refusedRequests[number]) {
  const test = await preflightFixture();
  try {
    const { session, owner } = await test.open();
    await session.rpc('thread/start', {});
    await expect(session.rpc(request.method, request.params)).rejects.toThrow('Private thread refused');
    await session.closed;
    expect(test.received).toEqual(['initialize', 'thread/start']);
    expect(test.callers.identify(`Bearer ${owner.caller}`)).toBeUndefined();
  } finally {
    await test.close();
  }
}
it.each(refusedRequests)('refuses $method with mismatched or extra fields before native RPC',
  refusesOtherRequests);

async function lostReload() {
  const test = await preflightFixture();
  try {
    const prepared = await test.prepare();
    test.dropReloadReply();
    await expect(prepared.load()).rejects.toThrow('Private tools could not be loaded');
    expect(test.mcp.size).toBe(0);
    expect(test.callers.identify(`Bearer ${prepared.owner.caller}`)).toBeUndefined();
    function isReload(method: string) { return method === 'config/mcpServer/reload'; }
    expect(test.received.filter(isReload)).toHaveLength(1);
    expect(test.received).not.toContain('turn/start');
  } finally {
    await test.close();
  }
}
it('revokes access after a lost reload reply without resending it', lostReload);

async function cancelledDiscovery() {
  const test = await preflightFixture();
  try {
    const survivor = await test.prepare('survivor');
    await survivor.load();
    const prepared = await test.prepare();
    test.pauseDiscovery();
    const pending = expect(prepared.load()).rejects.toThrow('Private tools could not be loaded');
    function discoveryRequested() {
      function isInventory(method: string) { return method === 'mcpServerStatus/list'; }
      expect(test.received.filter(isInventory)).toHaveLength(2);
    }
    await vi.waitFor(discoveryRequested);
    prepared.abort.abort();
    await pending;
    test.resume();
    expect(test.mcp.size).toBe(1);
    expect(test.callers.identify(`Bearer ${survivor.owner.caller}`)).toBe('survivor');
    expect(test.received).not.toContain('turn/start');
  } finally {
    await test.close();
  }
}
it('drops a cancelled discovery while preserving a second session', cancelledDiscovery);
