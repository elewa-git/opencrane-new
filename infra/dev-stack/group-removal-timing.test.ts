import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { measureRemoval } from './group-removal-timing.ts';

async function ignoresTheOwnersSlowList(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  function at(milliseconds: number): Promise<void> {
    return new Promise(function wait(resolve) {
      setTimeout(resolve, milliseconds);
    });
  }
  async function accept() {
    await at(600);
    return Date.now();
  }
  async function ownerList() {
    await at(3_000);
  }
  async function pageCleared() {
    await at(1_100);
  }
  async function historyRefused() {
    await at(700);
  }
  const observations = { ownerList, pageCleared, historyRefused };
  const resultPromise = measureRemoval(accept, observations);
  for (let index = 0; index < 40; index++) {
    context.mock.timers.tick(100);
    await setImmediate();
  }
  const result = await resultPromise;
  assert.equal(result.hops['pageCleared'], 500);
  assert.equal(result.hops['historyRefused'], 100);
  assert.equal(result.hops['ownerList'], 2_400);
  assert.equal(result.passed, true, 'A slow Owner list must not fail timely access loss');
}

test('times access loss from acceptance while the Owner list updates independently',
  ignoresTheOwnersSlowList);

async function refusesLateAccessLoss(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  async function accept() {
    return Date.now();
  }
  async function pageCleared() {
    await new Promise(function wait(resolve) {
      setTimeout(resolve, 2_001);
    });
  }
  const resultPromise = measureRemoval(accept, { pageCleared });
  await setImmediate();
  context.mock.timers.tick(2_001);
  await setImmediate();
  const result = await resultPromise;
  assert.equal(result.hops['pageCleared'], 2_001);
  assert.equal(result.passed, false, 'Keep the two-second limit unchanged');
}

test('fails when the removed page clears after two seconds', refusesLateAccessLoss);

async function startsTheNextReadAfterAcceptance(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  async function accept() {
    await new Promise(function wait(resolve) {
      setTimeout(resolve, 600);
    });
    return Date.now();
  }
  let readAt: number | undefined;
  async function historyRefused(accepted: Promise<number>) {
    await accepted;
    readAt = Date.now();
  }
  const resultPromise = measureRemoval(accept, { historyRefused });
  await setImmediate();
  context.mock.timers.tick(600);
  await setImmediate();
  const result = await resultPromise;
  assert.equal(readAt, 600, 'A refusal before removal cannot prove that the next read is refused');
  assert.equal(result.hops['historyRefused'], 0);
}

test('checks the next API read after the removal response', startsTheNextReadAfterAcceptance);
