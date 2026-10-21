import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runDemoSmoke } from './demo-smoke-run.ts';
import { demoRecording } from './test/demo-recording.ts';
import { browserRecording } from './test/demo-browser-recording.ts';
import { spendingRecording } from './test/demo-spending-recording.ts';

async function recordsFailedWarmUp() {
  const fixture = await demoRecording();
  fixture.allowPreparation();
  const browser = browserRecording(false, true);
  const store = spendingRecording(browser.callCount);
  const output = `${fixture.options.directory}/demo-smoke/failed-warm`;
  try {
    await assert.rejects(runDemoSmoke(browser, fixture.options, 700, output,
      'fixture-sha', store, 'fixture'), /Synthetic private warm-up failure/u);
    const spending = JSON.parse(await readFile(`${output}/spending.json`, 'utf8'));
    assert.equal(spending.starting.position, 10);
    assert.equal(spending.starting.budget.ceilingCents, 100);
    assert.equal(spending.starting.budget.dailyCeilingCents, 80);
    assert.equal(spending.callCount, 3);
    assert.equal(spending.chargedCents, 4);
    assert.equal(spending.heldCents, 25);
    assert.deepEqual(spending.calls, [
      { reservationId: 'charged-call', turnId: 'turn-1', chargedCents: 4, heldCents: 0 },
      { reservationId: 'held-call', turnId: 'turn-1', chargedCents: null, heldCents: 25 },
      { reservationId: 'unsent-call', turnId: 'turn-1', chargedCents: 0, heldCents: 0 },
    ]);
    assert.equal(spending.budget.ceilingCents, 100);
    const timings = JSON.parse(await readFile(`${output}/timings.json`, 'utf8'));
    assert.equal(timings.sha, 'fixture-sha');
    assert.equal(timings.warmResult, 'FAIL');
    assert.equal(typeof timings.warmMs, 'number');
    assert.deepEqual(timings.attempts, []);
    assert(!JSON.stringify(timings).includes('Synthetic private'));
    assert.equal(fixture.budget.ceilingCents, 100);
    assert.equal(fixture.budget.dailyCeilingCents, 80);
  } finally {
    await fixture.close();
  }
}
test('a failed warm-up records its own charged and held calls, starting snapshot and timings',
  recordsFailedWarmUp);
