import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { readComputerControl } from '@opencrane/auth';
import { envelope } from '@opencrane/models';
import { savePausing } from '../src/chat/bridge-pausing.ts';

let cleanup = async () => {};
afterEach(async function closeFixture() {
  vi.restoreAllMocks();
  await cleanup();
});

async function setup() {
  const test = await natsFixture();
  cleanup = test.close;
  const binding = { generation: 1, podUid: 'pod', takeoverId: 'takeover',
    affectedTurnIds: ['first', 'second'] };
  const intent = { ...binding, computerId: 'computer', assistantId: 'assistant',
    conversationId: 'chat', requesterId: 'alice', requesterEventId: 'first',
    leaseId: 'takeover', reason: 'requester_requested' };
  await test.seed([envelope('test', 'computer-assistant', 'takeover.requested', intent)]);
  const control = await readComputerControl(test.store, 'test', 'assistant');
  if (!control || control.phase !== 'requested') throw new Error('Missing request');
  const requested = control;
  const position = await test.store.head('computer-assistant');
  const receipt = { kind: 'executor_stop', ...binding, epoch: 'supervisor-epoch',
    executionQuiet: true, executionInventory: [], quietProof: 'unavailable',
    controlEnabled: false };
  function save(report: unknown) {
    return savePausing(test.store, 'test', requested, position, 'bridge-epoch', report);
  }
  return { ...test, position, receipt, save };
}

const requiredFields = ['kind', 'generation', 'podUid', 'takeoverId', 'affectedTurnIds',
  'epoch', 'executionQuiet', 'executionInventory', 'quietProof', 'controlEnabled'];
async function refusesMissingField(field: string) {
  const test = await setup();
  const receipt: Record<string, unknown> = { ...test.receipt };
  delete receipt[field];
  const append = vi.spyOn(test.store, 'append');
  await expect(test.save(receipt)).rejects.toThrow();
  expect(append).not.toHaveBeenCalled();
  expect(await test.store.head('computer-assistant')).toBe(test.position);
}
it.each(requiredFields)('requires the single supervisor field %s before appending',
  refusesMissingField);

async function refusesWrongKind() {
  const test = await setup();
  const append = vi.spyOn(test.store, 'append');
  await expect(test.save({ ...test.receipt, kind: 'bridge_quiet' })).rejects.toThrow();
  expect(append).not.toHaveBeenCalled();
  expect(await test.store.head('computer-assistant')).toBe(test.position);
}
it('refuses a receipt from a different operation before appending', refusesWrongKind);

async function checksReadBack(missing: boolean) {
  const test = await setup();
  const append = test.store.append.bind(test.store);
  async function wrongReply(...args: Parameters<typeof append>) {
    const result = await append(...args);
    if (result.status !== 'appended') return result;
    const sequence = missing ? result.sequence + 1 : test.position;
    return { ...result, sequence };
  }
  vi.spyOn(test.store, 'append').mockImplementation(wrongReply);
  await expect(test.save(test.receipt)).rejects.toThrow(/^Stop unavailable$/u);
  // Confirm the append happened, but its reply did not prove which event was saved.
  expect(await test.store.head('computer-assistant')).toBe(test.position + 1);
}
it.each([false, true])('refuses mismatched read-back with a missing event: %s', checksReadBack);

async function refusesAppend() {
  const test = await setup();
  const result = { status: 'conflict' as const };
  vi.spyOn(test.store, 'append').mockResolvedValue(result);
  const read = vi.spyOn(test.store, 'readStream');
  await expect(test.save(test.receipt)).rejects.toThrow(/^Stop unavailable$/u);
  expect(read).not.toHaveBeenCalled();
  expect(await test.store.head('computer-assistant')).toBe(test.position);
}
it('refuses an unsuccessful append before reading it back', refusesAppend);
