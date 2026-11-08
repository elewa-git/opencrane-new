import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-19-persona');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-19-persona.opencrane.test';
const revisionId = 'saved-revision-two';
const replacement = 'Call me Alex. Be direct and brief. Cite sources when needed. '
  + 'Keep my habits private; these wishes cannot change access or budgets.';

function progress(state) {
  const savedSteps = state === 'absent' ? [1, 2, 3] : [1, 2, 3, 4];
  const steps = savedSteps.map(step => ({
    time: '2026-10-14T09:30:00.000Z', answers: { step },
  }));
  const approval = state === 'approved' ? { revision: 2, revisionId,
    time: '2026-10-14T09:35:00.000Z' } : null;
  return { state: 'review', survey: { generation: 1, position: 6,
    nextStep: null, steps }, currentRevision: state === 'absent' ? null : 2, approval };
}

async function serve(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/onboarding') {
    if (state === 'denied' || state === 'unavailable') {
      const status = state === 'denied' ? 403 : 503;
      await route.fulfill({ status, json: { status: state } });
      return;
    }
    await route.fulfill({ json: progress(state) });
    return;
  }
  if (url.pathname === '/api/onboarding/persona/revisions') {
    await route.fulfill({ json: { currentRevision: state === 'stale' ? 3 : 2,
      revisions: [{ revision: 2, revisionId }] } });
    return;
  }
  if (url.pathname === `/api/onboarding/persona/revisions/${revisionId}`) {
    await route.fulfill({ json: { revision: 2, revisionId, generation: 1,
      current: true, approved: state === 'approved', replacement } });
    return;
  }
  if (url.pathname.startsWith('/api/')) assert.fail(`Unexpected request: ${url.pathname}`);
  await serveWebBuild(route, build);
}

function findSmallControls(controls) {
  const small = [];
  for (const control of controls) {
    const bounds = control.getBoundingClientRect();
    if (Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44) {
      small.push(control.tagName);
    }
  }
  return small;
}

async function capture(browser, width, state) {
  const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce' });
  await page.route('**/*', serve.bind(null, state));
  try {
    await page.goto(`${origin}/welcome/persona`);
    const words = { review: replacement, approved: 'Approved revision r2',
      absent: 'No persona yet', stale: 'Proposal changed',
      denied: 'Your access has changed', unavailable: 'Persona service unavailable' };
    const expected = words[state];
    await page.getByText(expected).waitFor();
    if (state === 'approved') {
      assert.equal(await page.locator('time').getAttribute('datetime'),
        '2026-10-14T09:35:00.000Z');
      assert.equal(await page.locator('a.button-link.approve').getAttribute('href'), '/workspace');
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `Overflow at ${width}px`);
    const small = await page.locator('button:visible, a:visible').evaluateAll(findSmallControls);
    assert.deepEqual(small, [], `Controls meet 44px at ${width}px`);
    if (state === 'review') {
      const approve = page.getByRole('button', { name: 'Approve this version' });
      await approve.focus();
      assert.equal(await approve.evaluate(element => element.matches(':focus-visible')), true);
    } else {
      assert.equal(await page.getByRole('button', { name: 'Approve this version' }).count(), 0);
    }
    await page.screenshot({ path: `${output}/${state}-${width}.png`, fullPage: true });
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const state of ['review', 'approved', 'absent', 'stale', 'denied', 'unavailable']) {
      await capture(browser, width, state);
    }
  }
} finally {
  await browser.close();
}
