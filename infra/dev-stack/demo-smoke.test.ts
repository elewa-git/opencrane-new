import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timedSmoke } from './demo-smoke.ts';

async function recordsFailuresAndDeadline() {
  let milliseconds = 0;
  const calls: string[] = [];
  function now() { return milliseconds; }
  async function streaming(remainingMs: number) {
    assert.equal(remainingMs, 180000);
    calls.push('streaming');
    milliseconds = 1000;
  }
  async function stop() {
    calls.push('stop');
    milliseconds = 180001;
    throw new Error('synthetic-private-value');
  }
  const steps = [
    { name: 'streaming', run: streaming },
    { name: 'stop', run: stop },
    { name: 'delivery', run: streaming },
  ];
  const result = await timedSmoke(steps, now);
  assert.deepEqual(calls, ['streaming', 'stop']);
  assert.deepEqual(result, { elapsedMs: 180001, result: 'FAIL', steps: [
    { name: 'streaming', result: 'PASS', elapsedMs: 1000 },
    { name: 'stop', result: 'FAIL', elapsedMs: 179001 },
    { name: 'delivery', result: 'NOT RUN', elapsedMs: 0 },
  ] });
  assert(!JSON.stringify(result).includes('synthetic-private-value'));
}

test('smoke records failures without private errors and refuses work after three minutes',
  recordsFailuresAndDeadline);
