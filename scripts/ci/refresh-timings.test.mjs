import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebuildTimings } from './refresh-timings.mjs';

function rebuildsMedianMilliseconds() {
  const first = { testResults: [
    { name: '/checkout/libs/one.test.ts', startTime: 100, endTime: 180 },
    { name: '/checkout/apps/two.test.ts', startTime: 200, endTime: 210 },
  ] };
  const second = { testResults: [
    { name: '/checkout/libs/one.test.ts', startTime: 500, endTime: 600 },
  ] };
  assert.deepEqual(rebuildTimings([first, second], '/checkout'), {
    'apps/two.test.ts': 10, 'libs/one.test.ts': 90,
  });
}

function refusesInvalidReports() {
  const invalid = { testResults: [
    { name: '/outside/one.test.ts', startTime: 100, endTime: 180 },
  ] };
  function outsideCheckout() {
    rebuildTimings([invalid], '/checkout');
  }
  assert.throws(outsideCheckout, /Invalid test timing/);
}

test('rebuilds sorted per-file medians in milliseconds across reports', rebuildsMedianMilliseconds);
test('refuses paths outside the original checkout', refusesInvalidReports);
