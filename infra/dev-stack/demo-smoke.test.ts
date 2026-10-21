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

async function refusesUnsafeSlots() {
  const { spawnSync } = await import('node:child_process');
  for (const id of ['', 'owner', '3']) {
    const env = { PATH: process.env['PATH'], DEV_STACK_ID: id, DEMO_ALLOWANCE_CENTS: '100' };
    const args = ['--experimental-strip-types', 'infra/dev-stack/demo-smoke-run.ts'];
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Demo smoke incomplete/u);
    assert.equal(result.stdout, '');
  }
}
test('smoke refuses missing, owner and invalid slots before loading settings', refusesUnsafeSlots);

async function requiresCurrentRefusal() {
  const { chromium } = await import('playwright');
  const { demoRefusal } = await import('./demo-browser.ts');
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(100);
    const old = '<article>Earlier attempt</article><article><oc-budget-stop-notice>' +
      'Company limit reached</oc-budget-stop-notice></article>';
    const current = '<article>This attempt</article>';
    await page.setContent(old + current + '<article>Still waiting</article>');
    await assert.rejects(demoRefusal(page, 'This attempt'));
    const refused = '<article><oc-budget-stop-notice>Company limit reached' +
      '</oc-budget-stop-notice></article>';
    await page.setContent(old + current + refused);
    await demoRefusal(page, 'This attempt');
  } finally {
    await browser.close();
  }
}
test('current budget refusal cannot pass by matching an earlier saved refusal', requiresCurrentRefusal);
