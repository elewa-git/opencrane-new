import { expect, it, vi } from 'vitest';
import { recallBackend, factText, scopeId, threadId } from './support/recall-backend.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';

vi.mock('node:net', { spy: true });
vi.mock('node:fs', async function filesystem(importOriginal) {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original };
});
vi.mock('node:child_process', async function processes(importOriginal) {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original };
});

async function recallsStoredFact() {
  const test = await recallBackend();
  await test.start();
  const before = await readChatFacts(test.setup.nats.store, 'test', 'chat', test.turnId);
  expect(before.memoryContext?.initialLoaded).toBe(true);
  expect(before.memoryContext?.references).toEqual([]);
  const args = { scopeId, query: 'garden' };
  const result = await test.native.recall(threadId, args);
  const expected = { result: { structuredContent: { facts: [
    { memoryId: 'garden', revision: 1, text: factText },
  ] } } };
  expect(result).toMatchObject(expected);
}
it('delivers a stored personal fact to the admitted native thread through the real backend',
  recallsStoredFact, 120_000);
