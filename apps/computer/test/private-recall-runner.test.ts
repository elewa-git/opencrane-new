import { expect, it, vi } from 'vitest';
import { privateToolOffer } from '../../server/test/support/private-catalogue.ts';
import { fixture } from './bridge-gate-fixture.ts';
import { preflightFixture } from './private-recall-preflight-fixture.ts';

vi.mock('node:net', { spy: true });

async function runnerFixture() {
  const native = await preflightFixture();
  async function open() {
    const opened = await native.open();
    return opened.session;
  }
  const computer = await fixture(true, undefined, open);
  Object.assign(computer.driver, native.driver);
  computer.pauseAcks();
  const tools = privateToolOffer('recall');
  const turn = { type: 'turn', id: 'first', conversationId: 'chat',
    assistantId: 'assistant', requesterId: 'alice', executionMode: 'restricted',
    text: 'Hello', token: 'preparing', expiresAt: Date.now() + 60_000, tools };
  computer.send(turn);
  function pending() {
    function matches(frame: Record<string, unknown>) { return frame['type'] === 'recall_pending'; }
    const frame = computer.frames.find(matches);
    expect(frame).toBeDefined();
    return frame!;
  }
  async function ready() { return vi.waitFor(pending); }
  function acknowledge() {
    function started(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.turn_started';
    }
    const start = computer.frames.find(started)!;
    const ack = { type: 'ack', sequence: start['sequence'], token: 'fixture-grant',
      expiresAt: Date.now() + 60_000, initialInput: 'Private fixture input' };
    computer.send(ack);
  }
  async function close() {
    await computer.close();
    await native.close();
  }
  return { native, computer, tools, ready, acknowledge, close };
}

async function loadsBeforeDispatch() {
  const test = await runnerFixture();
  try {
    const pending = await test.ready();
    expect(test.native.received).toEqual(['initialize', 'thread/start']);
    expect(test.computer.grants.size).toBe(0);
    const request = { ...pending, type: 'recall_load', tools: test.tools };
    test.computer.send(request);
    function loaded() {
      function matches(frame: Record<string, unknown>) { return frame['type'] === 'recall_loaded'; }
      expect(test.computer.frames.find(matches)).toEqual({ ...pending, type: 'recall_loaded' });
    }
    await vi.waitFor(loaded);
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
