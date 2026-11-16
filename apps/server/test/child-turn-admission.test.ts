import { expect, it, vi } from 'vitest';
import { admitChildTurn } from '../src/chat/child-turn.ts';

async function refusesWrongChildMode() {
  async function fresh() {}
  const child = { rootId: 'root', requesterId: 'alice', conversationId: 'child',
    turnId: 'input', threadId: 'thread', computerId: 'computer', assistantId: 'helper',
    payingGroupId: 'payer', deadline: performance.now() + 2000, fresh };
  function childStart() {
    return Promise.resolve(child);
  }
  const start = vi.fn(childStart);
  const context = { computerId: 'computer', assistantId: 'helper', childStart: start };
  const data = { requesterId: 'alice', conversationId: 'child', turnId: 'input',
    threadId: 'thread' };
  await expect(admitChildTurn(context, data, 'memory_free', undefined, {}))
    .rejects.toThrow('Child start binding changed');
  expect(start).not.toHaveBeenCalled();
  expect(data).not.toHaveProperty('rootId');
  expect(data).not.toHaveProperty('payingGroupId');
  const admitted = await admitChildTurn(context, data, 'restricted', undefined, {});
  expect(admitted.payer).toBe('payer');
  expect(data).toMatchObject({ rootId: 'root', sharingClass: 'shared_only' });
}
it('refuses memory-free child admission before requesting a spending root', refusesWrongChildMode);
