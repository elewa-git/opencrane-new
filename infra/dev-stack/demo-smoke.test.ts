import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { timedSmoke } from './demo-smoke.ts';
import { answer } from './real-model-journey.ts';

function warmPage(sharedSessionDelay = false) {
  let location = '';
  let statusChecks = 0;
  let sessionStarted = false;
  async function fill() {}
  async function press() {
    if (!location.includes('/workspace?conversation=')) {
      throw new Error('The shared session is still waiting in the chooser');
    }
  }
  async function innerText() {
    return 'ready';
  }
  async function waitFor() {}
  async function count() {
    return 1;
  }
  async function isEnabled() {
    return true;
  }
  async function click() {}
  function nth() {
    return element;
  }
  function locator() {
    return element;
  }
  function getByRole(role: string, options?: { name?: string | RegExp }) {
    return roleElement(role, options);
  }
  function getByText() {
    return element;
  }
  const element = {
    fill,
    press,
    innerText,
    waitFor,
    count,
    isEnabled,
    click,
    nth,
    locator,
    getByRole,
    getByText,
  };
  async function goto(url: string) {
    location = url;
  }
  function currentUrl() {
    return location;
  }
  async function reload() {}
  async function waitForLoadState() {}
  function roleElement(role: string, options?: { name?: string | RegExp }) {
    return page.getByRole(role, options);
  }
  async function startSession() {
    sessionStarted = true;
  }
  async function checkSessionStatus() {
    if (!sessionStarted) {
      return;
    }
    statusChecks += 1;
    if (statusChecks === 2) {
      location = 'http://demo.test/workspace?conversation=saved';
    }
  }
  function sessionStatusButton() {
    return { ...element, click: checkSessionStatus };
  }
  function startSessionButton() {
    return { ...element, click: startSession };
  }
  function statusButtonName(name: string | RegExp | undefined) {
    return name instanceof RegExp && /Check status|Checking/u.test(name.source);
  }
  function pageRole(_role: string, options?: { name?: string | RegExp }) {
    const name = options?.name;
    if (sharedSessionDelay && name === 'Start session') {
      return startSessionButton();
    }
    if (sharedSessionDelay && statusButtonName(name)) {
      return sessionStatusButton();
    }
    return element;
  }
  function setDefaultTimeout() {}
  const page = {
    setDefaultTimeout,
    goto,
    url: currentUrl,
    reload,
    waitForLoadState,
    locator,
    getByText,
    getByRole: pageRole,
  };
  function checkCount() {
    return statusChecks;
  }
  const fixture = { page: page as unknown as Page, statusChecks: checkCount };
  return fixture;
}

async function warmsOwnerAndDelayedSharedSession() {
  const { warmDemo } = await import('./demo-browser.ts');
  const ownerFixture = warmPage();
  const memberFixture = warmPage(true);
  const origin = 'http://demo.test';
  const sharedUrl = await warmDemo(ownerFixture.page, memberFixture.page, origin);
  assert.equal(sharedUrl, 'http://demo.test/workspace?conversation=saved');
  assert.equal(memberFixture.statusChecks(), 2);
}
test('warm-up waits for a delayed shared session before sending its reply',
  warmsOwnerAndDelayedSharedSession);

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
    const body = `<section class="transcript" aria-busy="false"></section>
      <oc-chat-composer><textarea aria-label="Message your agent"
      onkeydown="if(event.key==='Enter') start()"></textarea></oc-chat-composer>
      <script>
      function stopped() {
        localStorage.setItem('stopped', 'yes');
        document.querySelector('article').innerHTML =
          '<div class="prose">London is a city.</div>' +
          '<span class="turn-status">Stopped · partial reply kept</span>';
      }
      function start() {
        document.body.innerHTML = '<oc-chat-composer>Loading your workspace…</oc-chat-composer>' +
          '<article aria-label="Agent reply"><div class="prose">London is a city.</div>' +
          '<button onclick="stopped()">Stop</button></article>';
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
test('demo Stop uses the reply control without a caret while the composer is loading',
  stopsWhileComposerLoads);

async function failsWithinDeadline() {
  let milliseconds = 0;
  function now() { return milliseconds; }
  async function fail() {
    milliseconds = 1_000;
    throw new Error('Synthetic failure');
  }
  const failedStep = { name: 'failed step', run: fail };
  const steps = [failedStep];
  const result = await timedSmoke(steps, now);
  assert.deepEqual(result, { elapsedMs: 1000, result: 'FAIL', steps: [
    { name: 'failed step', result: 'FAIL', elapsedMs: 1000 },
  ] });
}
async function exceedsDeadlineDespitePassing() {
  let milliseconds = 0;
  function now() { return milliseconds; }
  async function pass() { milliseconds = 180_001; }
  const slowStep = { name: 'slow success', run: pass };
  const steps = [slowStep];
  const result = await timedSmoke(steps, now);
  assert.deepEqual(result, { elapsedMs: 180001, result: 'FAIL', steps: [
    { name: 'slow success', result: 'PASS', elapsedMs: 180001 },
  ] });
}
test('one failed step refuses the smoke even within 180 seconds', failsWithinDeadline);
test('all passing steps still refuse the smoke beyond 180 seconds', exceedsDeadlineDespitePassing);

async function checksReply(mode: string) {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const body = `<section class="transcript" aria-busy="false">
      <article aria-label="Agent reply"><div class="prose">Earlier 437</div><p class="turn-status">Done</p></article>
      <textarea aria-label="Message your agent" onkeydown="send(event)"></textarea>
      <div id="sent"></div></section><script>
      function send(event) {
        if (event.key !== 'Enter') {
          return;
        }
        const mode = new URL(location.href).searchParams.get('mode');
        let prose = mode === 'wrong' ? 'Incorrect' : '437';
        if (mode === 'unfinished') {
          prose += '<p>Done</p>';
        }
        const status = mode === 'unfinished' ? '' : '<p class="turn-status">Done</p>';
        if (mode === 'missing') {
          return;
        }
        const reply = '<article aria-label="Agent reply"><div class="prose">' +
          prose + '</div>' + status + '</article>';
        document.querySelector('#sent').insertAdjacentHTML('beforeend', reply);
        localStorage.setItem('reply', document.querySelector('#sent').innerHTML);
      }
      const saved = localStorage.getItem('reply') || '';
      const changed = new URL(location.href).searchParams.get('mode') === 'changed';
      document.querySelector('#sent').innerHTML = changed ? saved.replace('437', '438') : saved;
      </script>`;
    async function respond(route: import('playwright').Route) {
      await route.fulfill({ contentType: 'text/html', body });
    }
    await page.route('http://answer.test/**', respond);
    await page.goto(`http://answer.test/?mode=${mode}`);
    if (mode === 'completed') {
      await answer(page, 'Calculate the result', [/\b437\b/u]);
      assert.equal(await page.locator('.caret').count(), 0,
        'The reply finished in the Enter handler, before the completion wait');
      await answer(page, 'Calculate the result', [/\b437\b/u]);
    } else {
      let failure = /locator.waitFor: Timeout/u;
      if (mode === 'wrong') {
        failure = /must contain the expected fact/u;
      }
      if (mode === 'changed') {
        failure = /Reload keeps the answer/u;
      }
      await assert.rejects(answer(page, 'Calculate the result', [/\b437\b/u]), failure);
    }
  } finally {
    await browser.close();
  }
}
async function acceptsCompletedReply() {
  await checksReply('completed');
}
async function refusesEarlierReply() {
  await checksReply('missing');
}
async function refusesWrongFacts() {
  await checksReply('wrong');
}
async function refusesUnfinishedReply() {
  await checksReply('unfinished');
}
async function refusesChangedReload() {
  await checksReply('changed');
}
test('a reply completed before waiting passes, including a repeated question', acceptsCompletedReply);
test('an earlier correct answer cannot pass a send with no new reply', refusesEarlierReply);
test('wrong reply facts still fail', refusesWrongFacts);
test('Done inside unfinished reply prose cannot pass the completion check', refusesUnfinishedReply);
test('changed reply text after reload still fails', refusesChangedReload);
