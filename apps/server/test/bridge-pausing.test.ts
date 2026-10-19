import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { readComputerControl } from '@opencrane/auth';
import { envelope } from '@opencrane/models';
import { savePausing, savePaused, saveFailed } from '../src/chat/bridge-pausing.ts';

let cleanup = async () => {};
afterEach(async function closeFixture() {
  vi.restoreAllMocks();
  await cleanup();
});

async function setup(affectedTurnIds = ['first', 'second']) {
  const test = await natsFixture();
  cleanup = test.close.bind(test);
  const binding = { generation: 1, podUid: 'pod', takeoverId: 'takeover', affectedTurnIds };
  const intent = { ...binding, computerId: 'computer', assistantId: 'assistant',
    conversationId: 'chat', requesterId: 'alice', requesterEventId: 'first',
    leaseId: 'takeover', reason: 'requester_requested' };
  await test.seed([envelope('test', 'computer-assistant', 'takeover.requested', intent)]);
  const control = await readComputerControl(test.store, 'test', 'assistant');
  if (!control || control.phase !== 'requested') throw new Error('Missing request');
  const requested = control;
  const position = await test.store.head('computer-assistant');
  const receipt = { kind: 'executor_stop', ...binding, epoch: 'supervisor-epoch',
    executionQuiet: true, executionInventory: [], desktopInventory: [], quietProof: 'complete',
    controlEnabled: false };
  function save(report: unknown) {
    return savePausing(test.store, 'test', requested, position, 'bridge-epoch', report);
  }
  return { ...test, requested, position, receipt, save };
}

const requiredFields = ['kind', 'generation', 'podUid', 'takeoverId', 'affectedTurnIds',
  'epoch', 'executionQuiet', 'executionInventory', 'desktopInventory', 'quietProof', 'controlEnabled'];
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

async function savesBoundOutcome(phase: 'paused' | 'failed', fromPausing: boolean) {
  const test = await setup();
  if (phase === 'paused') {
    await expect(savePaused(test.store, 'test', test.requested, test.position,
      'bridge-epoch', test.receipt)).rejects.toThrow();
  }
  if (fromPausing) await test.save(test.receipt);
  const control = await readComputerControl(test.store, 'test', 'assistant');
  if (!control || control.phase === 'unverified') throw new Error('Missing control');
  const position = await test.store.head('computer-assistant');
  if (phase === 'paused') {
    await savePaused(test.store, 'test', control, position, 'new-bridge', test.receipt);
  } else {
    await saveFailed(test.store, 'test', control, position);
  }
  const reason = phase === 'failed' ? 'pause_timeout' : 'requester_requested';
  expect(await readComputerControl(test.reader, 'test', 'assistant')).toMatchObject({ phase, reason });
  const ended = await readComputerControl(test.store, 'test', 'assistant');
  if (!ended || ended.phase === 'unverified') throw new Error('Missing outcome');
  await expect(saveFailed(test.store, 'test', ended, position)).rejects.toThrow();
}
it.each([['paused', true], ['failed', false], ['failed', true]] as const)(
  'saves and rebuilds bound %s without outside calls, after pausing: %s', savesBoundOutcome);

async function refusesQuietReceipt(changes: Record<string, unknown>) {
  const test = await setup();
  await test.save(test.receipt);
  const control = await readComputerControl(test.store, 'test', 'assistant');
  if (!control || control.phase === 'unverified') throw new Error('Missing control');
  const position = await test.store.head('computer-assistant');
  const receipt = { ...test.receipt, ...changes };
  await expect(savePaused(test.store, 'test', control, position, 'bridge-epoch', receipt))
    .rejects.toThrow();
  expect(await test.store.head('computer-assistant')).toBe(position);
}
it.each([{ epoch: 'other' }, { podUid: 'other' }, { generation: 2 }, { takeoverId: 'other' },
  { affectedTurnIds: ['second', 'first'] }, { extra: true }, { executionInventory: ['process'] },
  { desktopInventory: 'unavailable' }, { desktopInventory: ['browser'] },
  { quietProof: 'unavailable' }])('refuses incomplete or misbound quiet proof %j',
  refusesQuietReceipt);

async function refusesMismatchedFold(phase: 'paused' | 'failed') {
  const test = await setup();
  await test.save(test.receipt);
  const binding = { assistantId: 'assistant', computerId: 'computer', generation: 1,
    podUid: 'pod', takeoverId: 'other', affectedTurnIds: ['first', 'second'] };
  let data: unknown = { ...binding, reason: 'pause_timeout' };
  if (phase === 'paused') {
    data = { ...binding, bridgeEpoch: 'bridge-epoch', supervisorEpoch: 'supervisor-epoch',
      quietProof: 'complete' };
  }
  await test.seed([envelope('test', 'computer-assistant', `takeover.${phase}`, data)]);
  expect(await readComputerControl(test.store, 'test', 'assistant'))
    .toMatchObject({ phase: 'unverified' });
}
it.each(['paused', 'failed'] as const)('keeps a mismatched %s fold unverified',
  refusesMismatchedFold);

async function failsOversizedRequest() {
  const turns = [];
  for (let index = 0; index < 65; index++) turns.push(`turn-${index}`);
  const test = await setup(turns);
  await saveFailed(test.store, 'test', test.requested, test.position);
  expect(await readComputerControl(test.store, 'test', 'assistant'))
    .toMatchObject({ phase: 'failed', affectedTurnIds: turns });
}
it('can fail a saved request that exceeds the signed gate cap', failsOversizedRequest);
