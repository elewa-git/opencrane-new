import { expect, it, vi } from 'vitest';
import { approvalHolds } from '../src/approval-holds.ts';

const approvalId = 'a'.repeat(64);
function fixture(limit = 1000) {
  const waiting = vi.fn().mockReturnValue(true);
  const renew = vi.fn().mockResolvedValue(undefined);
  const holds = approvalHolds({ waiting, renew }, limit);
  holds.resume(true);
  const send = vi.fn().mockResolvedValue(undefined);
  const answer = vi.fn();
  const input = { approvalId, thread: 'thread', send, answer };
  return { holds, waiting, renew, send, answer, input };
}
async function approvesOnce() {
  const test = fixture();
  const otherAnswer = vi.fn();
  test.holds.add(test.input);
  test.holds.add({ ...test.input, answer: otherAnswer });
  await Promise.all([test.holds.settle(approvalId, 'approved'),
    test.holds.settle(approvalId, 'approved')]);
  expect(test.renew).toHaveBeenCalledOnce();
  expect(test.send).toHaveBeenCalledOnce();
  expect(otherAnswer).toHaveBeenCalledOnce();
  test.holds.add(test.input);
  expect(test.send).toHaveBeenCalledOnce();
  expect(test.answer).toHaveBeenCalledOnce();
}
it('renews before sending once and answers duplicate holds and wakes', approvesOnce);
async function refuses(state: string, message: string) {
  const test = fixture();
  test.holds.add(test.input);
  await test.holds.settle(approvalId, state);
  expect(test.renew).toHaveBeenCalledOnce();
  expect(test.send).not.toHaveBeenCalled();
  expect(test.answer).toHaveBeenCalledWith(message);
}
it.each([
  ['denied', 'The requester denied this action. Nothing was sent.'],
  ['expired', 'The approval expired. Nothing was sent.'],
  ['cancelled', 'The approval was cancelled. Nothing was sent.'],
  ['outcome_unknown', 'The approval was already used; the tool may have received this action.'],
  ['unexpected', 'This action was not approved. Nothing was sent.'],
])(
  'renews and refuses %s with no send', refuses);
async function endsDuringRenewal(cause: string) {
  const test = fixture();
  let renewed!: () => void;
  function wait(resolve: () => void) { renewed = resolve; }
  test.renew.mockReturnValue(new Promise<void>(wait));
  test.holds.add(test.input);
  const waking = test.holds.settle(approvalId, 'approved');
  if (cause === 'rollback') test.holds.resume(false);
  else test.holds.endThread('thread');
  renewed();
  await waking;
  expect(test.send).not.toHaveBeenCalled();
  expect(test.answer).toHaveBeenCalledOnce();
}
it.each(['rollback', 'stop'])('refuses %s even during renewal', endsDuringRenewal);
async function expires() {
  vi.useFakeTimers();
  try {
    const test = fixture(15);
    test.holds.add(test.input);
    await vi.advanceTimersByTimeAsync(16);
    await test.holds.settle(approvalId, 'approved');
    expect(test.renew).toHaveBeenCalledOnce();
    expect(test.send).not.toHaveBeenCalled();
    expect(test.answer).toHaveBeenCalledWith(expect.stringContaining('time'));
  } finally { vi.useRealTimers(); }
}
it('gives up at the wait limit and ignores approval afterwards', expires);
function refusesUnsupportedAndWrongThread() {
  const test = fixture();
  test.holds.resume(false);
  test.holds.add(test.input);
  expect(test.waiting).not.toHaveBeenCalled();
  expect(test.answer).toHaveBeenCalledOnce();
  test.holds.resume(true);
  test.holds.add(test.input);
  test.holds.add({ ...test.input, thread: 'another' });
  expect(test.answer).toHaveBeenCalledTimes(2);
  test.holds.resume(true);
  expect(test.waiting).toHaveBeenCalledTimes(2);
  test.holds.endThread('thread');
}
it('requires support on every resume and refuses another thread sharing an id',
  refusesUnsupportedAndWrongThread);
