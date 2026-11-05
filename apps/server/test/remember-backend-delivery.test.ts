import { memoryWrittenEventSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { recallBackend, scopeId, threadId } from './support/recall-backend.ts';

function createMockOptions() {
  return { spy: true };
}
const mockOptions = vi.hoisted(createMockOptions);
vi.mock('node:net', mockOptions);
async function filesystem() {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...original };
}
vi.mock('node:fs', filesystem);
async function processes() {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...original };
}
vi.mock('node:child_process', processes);

const text = 'My walking destination is the summer garden.';
const content = z.object({ recallProof: z.string() });
const result = z.object({ structuredContent: content });
const recalled = z.object({ result });
async function rememberInput(test: Awaited<ReturnType<typeof recallBackend>>) {
  const query = { scopeId, query: 'garden' };
  const response = await test.native.recall(threadId, query);
  const recallProof = recalled.parse(response).result.structuredContent.recallProof;
  const reference = { scopeId, memoryId: 'garden', revision: 1 };
  return { scopeId, commandId: 'native-remember', text, kind: 'fact', pinned: false,
    expiresAt: null, sources: [], dependsOn: [reference], recallProof };
}

async function savesRememberReceipt() {
  const test = await recallBackend(true);
  await test.start();
  expect(test.wire.paths).toEqual([]);
  const args = await rememberInput(test);
  const response = await test.native.call(threadId, 'remember', args);
  const rows = await history(test.setup.nats.store, `scope-${scopeId}`, 'test');
  function matches(row: typeof rows[number]) {
    return row.event.commandId === args.commandId;
  }
  const writes = rows.filter(matches);
  expect(writes).toHaveLength(1);
  const saved = memoryWrittenEventSchema.parse(writes[0]!.event);
  expect(saved.principal).toEqual({ kind: 'agent', id: 'alice' });
  const receipt = { outcome: 'saved', changeId: saved.id, memoryId: saved.data.memoryId,
    revision: 1, scopeId, audience: { kind: 'person', ownerId: 'alice' }, savedAt: saved.time };
  expect(response).toEqual({ jsonrpc: '2.0', id: 1,
    result: { content: [], structuredContent: receipt } });
  expect(saved.data).toMatchObject({ dependsOn: args.dependsOn, ownerId: 'alice' });
  await test.setup.runner.run(test.projection);
  const query = { scopeId, query: 'summer' };
  const found = await test.native.recall(threadId, query);
  expect(JSON.stringify(found)).toContain(text);
  expect(JSON.stringify(rows)).not.toContain(text);
}
it('saves one own-person revision and returns the real Remember receipt on its native thread',
  savesRememberReceipt, 120_000);
