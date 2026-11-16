import { expect, it, vi } from 'vitest';
import { fixture } from './bridge-gate-fixture.ts';
import { privateToolOffer } from '../../server/test/support/private-catalogue.ts';
import { privateRecall } from '../src/private-recall.ts';
import { parseTurn } from '../src/turn-frame.ts';
import { preflightFixture } from './private-recall-preflight-fixture.ts';

vi.mock('node:net', { spy: true });

const refusedAttachments = [
  { attachments: { name: 'malformed' } },
  { attachments: null },
  { attachments: [{ name: 'private.pdf' }] },
  { omittedAttachments: 1 },
];
async function refusesAttachments(change: object) {
  const computer = await fixture();
  try {
    const turn = { type: 'turn', id: 'first', conversationId: 'chat',
      assistantId: 'assistant', executionMode: 'restricted', text: 'Hello',
      token: 'initial', expiresAt: Date.now() + 60_000, ...change };
    computer.send(turn);
    function refused() {
      expect(computer.frames).toContainEqual(expect.objectContaining({
        type: 'agent.turn_failed', turnId: 'first', reason: 'model_error',
      }));
    }
    await vi.waitFor(refused);
    expect(computer.calls).toContain('thread/start:');
    expect(computer.calls).not.toContain('turn/start:thread-1');
    expect(computer.grants.size).toBe(0);
  } finally {
    await computer.close();
  }
}
it.each(refusedAttachments)('refuses restricted attachments before dispatch: %j',
  refusesAttachments);

async function checksRecallBoundary(kind: 'personal' | 'shared' | 'memory_free') {
  const native = await preflightFixture();
  try {
    const { session, owner } = await native.open();
    const tools = privateToolOffer('recall');
    const frame = { id: 'first', conversationId: 'chat', assistantId: 'assistant',
      requesterId: 'alice', executionMode: 'restricted', text: 'Hello', token: 'preparing',
      expiresAt: owner.expires, tools };
    const input = parseTurn(frame);
    if (kind === 'shared') input.sharingClass = 'shared_only';
    if (kind === 'memory_free') input.executionMode = 'memory_free';
    const identity = { verifier: {}, issuer: 'fixture', silo: 'test', computer: 'computer',
      assistant: 'assistant', generation: 1, podUid: 'pod' };
    function prepare() {
      return privateRecall(input, owner, session, identity, native.loads);
    }
    if (kind !== 'personal') {
      expect(prepare).toThrow('Private recall refused');
      expect(native.received).toEqual(['initialize']);
      expect(native.mcp.size).toBe(0);
      return;
    }
    const recall = prepare();
    const { receipt } = await recall.start();
    const load = { ...receipt, type: 'recall_load', tools };
    await expect(recall.load(load)).resolves.toEqual({ ...receipt, type: 'recall_loaded' });
    expect(recall.ready).toBe(true);
    expect(native.mcp.size).toBe(1);
    expect(native.received).toContain('mcpServerStatus/list');
    expect(native.received).not.toContain('turn/start');
  } finally {
    await native.close();
  }
}
it.each(['personal', 'shared', 'memory_free'] as const)(
  'checks the %s recall boundary with a valid personal catalogue', checksRecallBoundary);
