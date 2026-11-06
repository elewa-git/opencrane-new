import { expect, it, vi } from 'vitest';
import { privateToolOffer } from '../../server/test/support/private-catalogue.ts';
import { privateLaunchContext } from '../src/private-launch-context.ts';
import { fixture } from './bridge-gate-fixture.ts';
import { preflightFixture } from './private-recall-preflight-fixture.ts';

vi.mock('node:net', { spy: true });

async function runnerFixture(remember = false) {
  const native = await preflightFixture(undefined, undefined, remember);
  async function open() {
    const launch = privateLaunchContext.getStore()!;
    const opened = await native.open(launch.turnId, launch.conversation);
    return opened.session;
  }
  const computer = await fixture(true, undefined, open);
  Object.assign(computer.driver, native.driver);
  computer.pauseAcks();
  const tools = privateToolOffer('recall');
  if (remember) {
    tools[0]!.definitions.push(...privateToolOffer('remember')[0]!.definitions);
    tools[0]!.modes['remember'] = 'allow';
    tools[0]!.definitions.push(...privateToolOffer('correct')[0]!.definitions);
    tools[0]!.modes['correct'] = 'allow';
  }
  const turn = { type: 'turn', id: 'first', conversationId: 'chat',
    assistantId: 'assistant', requesterId: 'alice', executionMode: 'restricted',
    text: 'Hello', token: 'preparing', expiresAt: Date.now() + 60_000, tools };
  computer.send(turn);
  async function ready(turnId = 'first') {
    function pending() {
      function matches(frame: Record<string, unknown>) {
        return frame['type'] === 'recall_pending' && frame['turnId'] === turnId;
      }
      const frame = computer.frames.find(matches);
      expect(frame).toBeDefined();
      return frame!;
    }
    return vi.waitFor(pending);
  }
  function acknowledge(initialInput = 'Private fixture input') {
    function started(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.turn_started';
    }
    const start = computer.frames.find(started)!;
    const ack = { type: 'ack', sequence: start['sequence'], token: 'fixture-grant',
      expiresAt: Date.now() + 60_000, initialInput };
    computer.send(ack);
  }
  async function close() {
    await computer.close();
    await native.close();
  }
  return { native, computer, tools, turn, ready, acknowledge, close };
}

async function waitLoaded(test: Awaited<ReturnType<typeof runnerFixture>>,
  pending: Record<string, unknown>) {
  const expectedReceipt = { ...pending, type: 'recall_loaded' };
  function loaded() {
    function matches(frame: Record<string, unknown>) {
      return frame['type'] === 'recall_loaded' && frame['turnId'] === pending['turnId'];
    }
    expect(test.computer.frames.find(matches)).toEqual(expectedReceipt);
  }
  await vi.waitFor(loaded);
}

async function loadsBeforeDispatch() {
  const test = await runnerFixture();
  try {
    const pending = await test.ready();
    expect(test.native.received).toEqual(['initialize', 'thread/start']);
    expect(test.computer.grants.size).toBe(0);
    const request = { ...pending, type: 'recall_load', tools: test.tools };
    test.computer.send(request);
    await waitLoaded(test, pending);
    expect(test.computer.grants.size).toBe(0);
    expect(test.native.received).not.toContain('turn/start');
    test.acknowledge();
    function dispatched() { expect(test.native.received).toContain('turn/start'); }
    await vi.waitFor(dispatched);
    expect(test.native.received).toEqual(['initialize', 'thread/start',
      'config/mcpServer/reload', 'mcpServerStatus/list', 'turn/start']);
    expect(test.native.mcp.size).toBe(1);
  } finally {
    await test.close();
  }
}
it('loads recall through the authenticated bridge before accepting input or a grant',
  loadsBeforeDispatch);

const changedBindings = [
  { threadId: 'other' }, { loadId: 'copied' }, { generation: 2 }, { inputGeneration: 2 },
  { requesterId: 'bob' }, { assistantId: 'other' }, { computerId: 'other' },
  { conversationId: 'other' }, { silo: 'other' }, { expiresAt: 1 }, { extra: true },
  { tools: privateToolOffer('remember') },
  { tools: [{ ...privateToolOffer('recall')[0], modes: { recall: 'ask' } }] },
];
async function refusesChangedBinding(change: object) {
  const test = await runnerFixture();
  try {
    const pending = await test.ready();
    const request = { ...pending, type: 'recall_load', tools: test.tools, ...change };
    test.computer.send(request);
    const expectedReceipt = { type: 'recall_refused', turnId: 'first' };
    function refused() {
      function matches(frame: Record<string, unknown>) { return frame['type'] === 'recall_refused'; }
      expect(test.computer.frames.find(matches)).toEqual(expectedReceipt);
    }
    await vi.waitFor(refused);
    expect(test.native.received).not.toContain('config/mcpServer/reload');
    expect(test.native.received).not.toContain('turn/start');
    expect(test.computer.grants.size).toBe(0);
    expect(test.native.mcp.size).toBe(0);
  } finally {
    await test.close();
  }
}
it.each(changedBindings)('refuses a copied or changed load binding: %j', refusesChangedBinding);

async function prematureGrant() {
  const test = await runnerFixture();
  try {
    await test.ready();
    test.acknowledge();
    function ended() { expect(test.native.callers.permits('first', 'first')).toBe(false); }
    await vi.waitFor(ended);
    expect(test.computer.grants.size).toBe(0);
    expect(test.native.received).not.toContain('turn/start');
  } finally {
    await test.close();
  }
}
it('refuses input and a grant that arrive before discovery', prematureGrant);

const interruptedLoads = ['Stop', 'lost reply', 'caller revoked', 'disconnect'] as const;
async function interruptedLoad(reason: typeof interruptedLoads[number]) {
  const test = await runnerFixture();
  try {
    const pending = await test.ready();
    if (reason === 'lost reply') test.native.dropReloadReply();
    else test.native.pauseDiscovery();
    const request = { ...pending, type: 'recall_load', tools: test.tools };
    test.computer.send(request);
    if (reason !== 'lost reply') {
      function waiting() { expect(test.native.received).toContain('mcpServerStatus/list'); }
      await vi.waitFor(waiting);
      if (reason === 'Stop') {
        const stop = { type: 'stop', turnId: 'first', conversationId: 'chat' };
        test.computer.send(stop);
      } else if (reason === 'disconnect') {
        test.computer.socket.terminate();
      } else {
        test.native.callers.remove('first');
      }
      function revoked() { expect(test.native.callers.permits('first', 'first')).toBe(false); }
      await vi.waitFor(revoked);
      test.native.resume();
    }
    function removed() {
      expect(test.native.received).toContain('config/mcpServer/reload');
      expect(test.native.mcp.size).toBe(0);
    }
    await vi.waitFor(removed);
    expect(test.computer.grants.size).toBe(0);
    expect(test.native.received).not.toContain('turn/start');
    function reload(method: string) { return method === 'config/mcpServer/reload'; }
    expect(test.native.received.filter(reload)).toHaveLength(1);
  } finally {
    await test.close();
  }
}
it.each(interruptedLoads)('removes a load after %s without dispatch or resend', interruptedLoad);

async function separateSessions() {
  const test = await runnerFixture();
  try {
    const first = await test.ready();
    const firstLoad = { ...first, type: 'recall_load', tools: test.tools };
    test.computer.send(firstLoad);
    await waitLoaded(test, first);
    const secondTurn = { ...test.turn, id: 'second', conversationId: 'second-chat' };
    test.computer.send(secondTurn);
    const second = await test.ready('second');
    expect(second['requesterId']).toBe(first['requesterId']);
    expect(second['loadId']).not.toBe(first['loadId']);
    const secondLoad = { ...second, type: 'recall_load', tools: test.tools };
    test.computer.send(secondLoad);
    await waitLoaded(test, second);
    expect(test.native.mcp.size).toBe(2);
    test.computer.send(secondLoad);
    function onlyFirst() { expect(test.native.mcp.size).toBe(1); }
    await vi.waitFor(onlyFirst);
    expect(test.native.callers.permits('first', 'first', String(first['threadId']))).toBe(true);
    expect(test.native.received).not.toContain('turn/start');
  } finally {
    await test.close();
  }
}
it('keeps same-user catalogues separate and refuses to repeat a load', separateSessions);

async function completeFrameLimit() {
  const test = await runnerFixture();
  try {
    const pending = await test.ready();
    const request = { ...pending, type: 'recall_load', tools: test.tools };
    test.computer.send(request);
    await waitLoaded(test, pending);
    test.acknowledge('x'.repeat(120 * 1024 - 400));
    function ended() { expect(test.native.callers.permits('first', 'first')).toBe(false); }
    await vi.waitFor(ended);
    expect(test.computer.grants.size).toBe(0);
    expect(test.native.received).not.toContain('turn/start');
  } finally {
    await test.close();
  }
}
it('counts the tools and credentials in the full frame before installing a grant', completeFrameLimit);

const nativeItems = ['recall', 'remember', 'correct', 'forget', 'external',
  'commandExecution', 'fileChange', 'webSearch', 'collabAgentToolCall'] as const;
async function restrictNativeItems(kind: typeof nativeItems[number], remember = false) {
  const test = await runnerFixture(remember);
  try {
    const pending = await test.ready();
    const request = { ...pending, type: 'recall_load', tools: test.tools };
    test.computer.send(request);
    await waitLoaded(test, pending);
    const item = { id: 'call', type: 'mcpToolCall', server: test.tools[0]!.key, tool: 'recall' };
    item.tool = kind;
    if (kind === 'external') {
      item.server = 'external';
    }
    if (kind === 'commandExecution' || kind === 'fileChange' || kind === 'webSearch'
      || kind === 'collabAgentToolCall') {
      item.type = kind;
    }
    const event = { method: 'item/started', params: { threadId: pending['threadId'], item } };
    test.computer.channel.notification(event);
    const expectedPermission = kind === 'recall'
      || (remember && (kind === 'remember' || kind === 'correct'));
    function expectedAccess() {
      const permitted = test.native.callers.permits('first', 'first');
      expect(permitted).toBe(expectedPermission);
    }
    await vi.waitFor(expectedAccess);
    expect(test.native.received).not.toContain('turn/start');
  } finally {
    await test.close();
  }
}
async function restrictRecallItems(kind: typeof nativeItems[number]) {
  await restrictNativeItems(kind);
}
it.each(nativeItems)('admits only loaded recall notifications: %s', restrictRecallItems);

async function restrictRememberItems(kind: typeof nativeItems[number]) {
  await restrictNativeItems(kind, true);
}
it.each(nativeItems)('admits only loaded personal memory notifications: %s', restrictRememberItems);
