import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { history } from '@opencrane/models';
import { memoryCorrectedEventSchema, memoryForgottenEventSchema } from '@opencrane/events';
import { readAgentChange } from '../src/memory/forget.ts';
import { recallBackend, scopeId, threadId } from './support/recall-backend.ts';
import { memoryClock } from './support/memory-clock.ts';

function createMockOptions() {
  return { spy: true };
}
const mockOptions = vi.hoisted(createMockOptions);
vi.mock('node:net', mockOptions);
async function filesystem() {
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...original };
}
async function processes() {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...original };
}
vi.mock('node:fs', filesystem);
vi.mock('node:child_process', processes);

const replacement = 'My walking destination is the summer garden.';
const recallProofShape = { recallProof: z.string() };
const recallProofSchema = z.object(recallProofShape);
const structuredContentShape = { structuredContent: recallProofSchema };
const structuredContentSchema = z.object(structuredContentShape);
const resultShape = { result: structuredContentSchema };
const recallResponseSchema = z.object(resultShape);

async function savedChanges(test: Awaited<ReturnType<typeof recallBackend>>) {
  const rows = await history(test.setup.nats.store, `scope-${scopeId}`, 'test');
  return rows;
}

async function nativeCorrectAndForget() {
  const test = await recallBackend(true);
  const firstClock = memoryClock();
  await test.start();
  const originalQuery = { scopeId, query: 'winter garden' };
  const original = await test.native.recall(threadId, originalQuery);
  const originalResponse = recallResponseSchema.parse(original);
  const proof = originalResponse.result.structuredContent.recallProof;
  const correctionRequest = { scopeId, commandId: 'combined-correct', memoryId: 'garden',
    expectedRevision: 1, text: replacement, kind: 'fact', pinned: false, expiresAt: null,
    dependsOn: [], recallProof: proof };
  const corrected = await test.native.call(threadId, 'correct', correctionRequest);
  const expectedCorrectionOutcome = 'accepted';
  const expectedCorrectionRevision = 2;
  expect(corrected).toHaveProperty('result.structuredContent.outcome',
    expectedCorrectionOutcome);
  expect(corrected).toHaveProperty('result.structuredContent.revision',
    expectedCorrectionRevision);
  firstClock.restore();

  await test.setup.runner.run(test.projection);
  const nextThread = 'returned-native-2';
  const next = await test.admit('after-correct', nextThread);
  const secondClock = memoryClock();
  await next.start();
  const currentQuery = { scopeId, query: 'summer garden' };
  const current = await test.native.recall(nextThread, currentQuery);
  expect(JSON.stringify(current)).toContain(replacement);
  expect(JSON.stringify(current)).not.toContain('winter garden');
  const currentResponse = recallResponseSchema.parse(current);
  const currentProof = currentResponse.result.structuredContent.recallProof;

  const append = test.setup.nats.store.append.bind(test.setup.nats.store);
  let forgetAppends = 0;
  async function loseForgetReply(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    if (memoryForgottenEventSchema.safeParse(command.event).success) {
      forgetAppends += 1;
      return { status: 'unavailable' as const, cause: new Error('Reply lost') };
    }
    return result;
  }
  vi.spyOn(test.setup.nats.store, 'append').mockImplementation(loseForgetReply);
  const forgetRequest = { scopeId, commandId: 'combined-forget', memoryId: 'garden',
    expectedRevision: 2, recallProof: currentProof };
  const forgotten = await test.native.call(nextThread, 'forget', forgetRequest);
  const expectedForgetOutcome = 'unknown';
  expect(forgotten).toHaveProperty('result.structuredContent.outcome',
    expectedForgetOutcome);
  secondClock.restore();
  const rows = await savedChanges(test);
  function isCorrection(row: typeof rows[number]) {
    return memoryCorrectedEventSchema.safeParse(row.event).success;
  }
  function isForget(row: typeof rows[number]) {
    return memoryForgottenEventSchema.safeParse(row.event).success;
  }
  expect(rows.filter(isCorrection)).toHaveLength(1);
  expect(rows.filter(isForget)).toHaveLength(1);
  expect(forgetAppends).toBe(1);
  const scope = { scopeId, scopeKind: 'person' as const, ownerId: 'alice' };
  const status = await readAgentChange(test.memory, 'alice', scope, forgetRequest.commandId);
  const expectedStatus = { operation: 'forget', outcome: 'accepted', hidden: true,
    revision: 3 };
  expect(status).toMatchObject(expectedStatus);
  expect(JSON.stringify(status)).not.toContain(replacement);

}

it('offers all four native tools and recovers Forget after Correct without a second append',
  nativeCorrectAndForget, 120_000);
