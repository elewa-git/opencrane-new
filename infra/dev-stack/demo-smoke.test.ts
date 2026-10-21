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
  for (const id of [undefined, '', 'owner', '3']) {
    const env = { PATH: process.env['PATH'], DEV_STACK_ID: id, DEMO_ALLOWANCE_CENTS: '100',
      DEV_STACK_DIR: '/invalid-demo-configuration' };
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/demo-smoke-preload.mjs', 'infra/dev-stack/demo-smoke-run.ts'];
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Demo tasks require an explicit secondary id/u);
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
    page.setDefaultTimeout(5000);
    const old = '<article>Earlier attempt</article><article><oc-budget-stop-notice>' +
      'Company limit reached</oc-budget-stop-notice></article>';
    const current = '<article><p>This attempt</p></article>';
    await page.setContent(old + current + '<article>Still waiting</article>');
    page.setDefaultTimeout(100);
    await assert.rejects(demoRefusal(page, 'This attempt'));
    page.setDefaultTimeout(5000);
    const refused = '<article><oc-budget-stop-notice>Company limit reached' +
      '</oc-budget-stop-notice></article>';
    await page.setContent(old + current + refused);
    await demoRefusal(page, 'This attempt');
  } finally {
    await browser.close();
  }
}
test('current budget refusal cannot pass by matching an earlier saved refusal', requiresCurrentRefusal);

async function waitsForSharedSession() {
  const { chromium } = await import('playwright');
  const { waitForPrivateSessionToApply } = await import('./browser-phase4.ts');
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    async function respond(route: import('playwright').Route) {
      const selected = route.request().url().includes('conversation=');
      const choosing = '<button onclick="location.href=\'/workspace?conversation=saved\'">' +
        'Check status</button>';
      const body = selected ? '<p>Private session</p>' : choosing;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    }
    await page.route('http://demo.test/**', respond);
    await page.goto('http://demo.test/workspace/shared');
    await waitForPrivateSessionToApply(page);
    assert.equal(page.url(), 'http://demo.test/workspace?conversation=saved');
  } finally { await browser.close(); }
}
test('demo can finish a recorded shared session by checking its saved status',
  waitsForSharedSession);

async function stopsWhileComposerLoads() {
  const { chromium } = await import('playwright');
  const { stop } = await import('./real-model-journey.ts');
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    const body = `<oc-chat-composer><textarea aria-label="Message your agent"
      onkeydown="if(event.key==='Enter') start()"></textarea></oc-chat-composer>
      <script>
      function stopped() {
        localStorage.setItem('stopped', 'yes');
        document.querySelector('article').innerHTML =
          '<div class="prose">London is a city.</div><span>Stopped · partial reply kept</span>';
      }
      function start() {
        document.body.innerHTML = '<oc-chat-composer>Loading your workspace…</oc-chat-composer>' +
          '<article aria-label="Agent reply"><div class="prose">London is a city.</div>' +
          '<span class="caret">|</span><button onclick="stopped()">Stop</button></article>';
      }
      if (localStorage.getItem('stopped')) { start(); stopped(); }
      </script>`;
    async function respond(route: import('playwright').Route) {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    }
    await page.route('http://stop.test/**', respond);
    await page.goto('http://stop.test/');
    await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
    page.setDefaultTimeout(5000);
    await stop(page);
    const reply = page.getByRole('article', { name: 'Agent reply', exact: true });
    assert.equal(await reply.locator('.prose').innerText(), 'London is a city.');
  } finally { await browser.close(); }
}
test('demo Stop uses the reply control while the composer is loading', stopsWhileComposerLoads);

async function failsWithinDeadline() {
  let milliseconds = 0;
  function now() { return milliseconds; }
  async function fail() {
    milliseconds = 1_000;
    throw new Error('Synthetic failure');
  }
  const result = await timedSmoke([{ name: 'failed step', run: fail }], now);
  assert.deepEqual(result, { elapsedMs: 1000, result: 'FAIL', steps: [
    { name: 'failed step', result: 'FAIL', elapsedMs: 1000 },
  ] });
}
async function exceedsDeadlineDespitePassing() {
  let milliseconds = 0;
  function now() { return milliseconds; }
  async function pass() { milliseconds = 180_001; }
  const result = await timedSmoke([{ name: 'slow success', run: pass }], now);
  assert.deepEqual(result, { elapsedMs: 180001, result: 'FAIL', steps: [
    { name: 'slow success', result: 'PASS', elapsedMs: 180001 },
  ] });
}
test('one failed step refuses the smoke even within 180 seconds', failsWithinDeadline);
test('all passing steps still refuse the smoke beyond 180 seconds', exceedsDeadlineDespitePassing);
