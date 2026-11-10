import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-20-welcome');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-20-welcome.opencrane.test';
const answer = 'A concise comparison of our two suppliers.';

function saved(state) {
  const completed = state === 'ONB-32' || state === 'ONB-33' || state === 'ONB-32-RM';
  return { status: completed ? 'completed' : 'welcome_active',
    welcomeId: 'saved-welcome', scriptVersion: 'welcome-v1', variant: 'assistant',
    revision: 2, revisionId: 'saved-revision', assignmentStatus: 'assigned',
    startedAt: '2026-10-14T09:02:00.000Z', completedAt: completed ?
      '2026-10-14T09:03:00.000Z' : null,
    position: completed ? 9 : 8, answered: completed ? 1 : 0,
    nextStep: completed ? null : 'weekly_help',
    question: completed ? null : 'What would make this week easier?',
    answer: completed ? answer : null };
}

function progress() {
  return { survey: { generation: 1, position: 8,
    steps: [1, 2, 3, 4] }, approval: { revision: 2, revisionId: 'saved-revision' } };
}

async function serve(state, route) {
  const address = new URL(route.request().url());
  if (address.pathname === '/api/onboarding/welcome') {
    if (state === 'denied') {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
    } else {
      await route.fulfill({ json: saved(state) });
    }
    return;
  }
  if (address.pathname === '/api/onboarding') {
    await route.fulfill({ json: progress() });
    return;
  }
  if (address.pathname.startsWith('/api/')) assert.fail(`Unexpected request: ${address.pathname}`);
  await serveWebBuild(route, build);
}

function tooSmall(controls) {
  const small = [];
  for (const control of controls) {
    const bounds = control.getBoundingClientRect();
    if (bounds.width < 44 || bounds.height < 44) small.push(control.tagName);
  }
  return small;
}

function expectedWords(state) {
  if (state === 'denied') return 'Private welcome words were cleared';
  if (state === 'ONB-30' || state === 'ONB-31') return 'What would make this week easier?';
  return answer;
}

function composerBottom(element) {
  return element.getBoundingClientRect().bottom;
}

async function capture(browser, state, width) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: 'reduce' });
  await page.route('**/*', serve.bind(null, state));
  try {
    const suffix = state === 'ONB-33' ? '?section=archived' : '';
    await page.goto(`${origin}/welcome${suffix}`);
    const expected = expectedWords(state);
    await page.getByText(expected).waitFor();
    if (state === 'ONB-31') {
      await page.getByText('Welcome back').waitFor();
    }
    if (state === 'ONB-30') {
      assert.equal(await page.getByText('Welcome back').count(), 0);
    }
    if (width === 1280 && state.startsWith('ONB-')) {
      assert.equal(await page.getByRole('navigation', { name: 'Sessions' }).count(), 1);
    }
    if (width === 390 && (state === 'ONB-30' || state === 'ONB-31')) {
      assert.equal(await page.locator('.composer-frame textarea').count(), 1);
    }
    if (state === 'denied') {
      assert.equal(await page.getByText(answer).count(), 0);
      assert.equal(await page.locator('textarea').count(), 0);
    }
    if (state === 'ONB-32' || state === 'ONB-32-RM' || state === 'ONB-33') {
      assert.equal(await page.locator('textarea').count(), 0);
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `Overflow: ${state} ${width}px`);
    const small = await page.locator('button:visible, a:visible').evaluateAll(tooSmall);
    assert.deepEqual(small, [], `Controls must reach 44px: ${state} ${width}px`);
    await page.screenshot({ path: `${output}/${state}-${width}.png`, fullPage: true });
    if (state === 'ONB-30' && width === 390) {
      await page.setViewportSize({ width: 390, height: 560 });
      const bottom = await page.locator('textarea').evaluate(composerBottom);
      assert(bottom <= 560, 'Composer stays above the resized phone viewport');
      await page.screenshot({ path: `${output}/keyboard-390.png`, fullPage: true });
    }
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const state of ['ONB-30', 'ONB-31', 'ONB-32', 'ONB-33', 'ONB-32-RM', 'denied']) {
      await capture(browser, state, width);
    }
  }
} finally {
  await browser.close();
}
