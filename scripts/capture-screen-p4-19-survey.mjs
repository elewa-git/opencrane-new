import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-19-survey');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-19-survey.opencrane.test';
const savedStep = {
  status: 'confirmed', commandId: 'saved', eventId: 'event',
  operation: 'onboarding.survey_step_saved', position: 1,
  time: '2026-10-14T09:30:00.000Z',
  answers: { step: 1, preferredName: 'Alex', pronouns: null },
};
const emptyProgress = {
  state: 'not_started', allowedActions: ['save_step', 'restart'], recentReceipts: [],
  survey: { generation: 1, position: 0, nextStep: 1, steps: [] },
};
const savedProgress = {
  state: 'survey', allowedActions: ['save_step', 'restart'], recentReceipts: [savedStep],
  survey: { generation: 1, position: 1, nextStep: 2, steps: [savedStep] },
};
const recoveredProgress = {
  state: 'survey',
  survey: { generation: 1, position: 3, nextStep: 4, steps: [
    savedStep,
    { time: '2026-10-14T09:31:00.000Z', answers: { step: 2 } },
    { time: '2026-10-14T09:32:00.000Z', answers: { step: 3 } },
  ] },
};

function serveRecovered(route) {
  return route.fulfill({ json: recoveredProgress });
}

async function serve(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: true, user: { name: 'Alex' } } });
    return;
  }
  if (url.pathname === '/api/onboarding') {
    if (state === 'ONB-17-loading') {
      await new Promise(() => {});
      return;
    }
    if (state === 'ONB-17-unavailable' || state === 'ONB-17-recovered') {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    const progress = state === 'ONB-12' || state === 'ONB-16' ? savedProgress : emptyProgress;
    await route.fulfill({ json: progress });
    return;
  }
  if (url.pathname === '/api/onboarding/survey') {
    if (state === 'ONB-15-saving') {
      await new Promise(() => {});
      return;
    }
    const result = state === 'ONB-15-unknown' ? 'unknown' : 'unavailable';
    await route.fulfill({ status: 503, json: { status: result } });
    return;
  }
  if (url.pathname.startsWith('/api/')) assert.fail(`Unexpected request: ${url.pathname}`);
  await serveWebBuild(route, build);
}

async function prepare(page, state) {
  if (state === 'ONB-17-loading') {
    await page.getByText('Checking your progress').waitFor();
    return;
  }
  if (state === 'ONB-17-unavailable') {
    await page.getByText('Your progress could not be loaded').waitFor();
    return;
  }
  if (state === 'ONB-17-recovered') {
    await page.getByText('Your progress could not be loaded').waitFor();
    await page.route('**/api/onboarding', serveRecovered);
    await page.getByRole('button', { name: 'Start again' }).click();
    await page.getByLabel('Name Required').fill('Taylor');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('We found your saved progress').waitFor();
    return;
  }
  if (state === 'ONB-12' || state === 'ONB-16') {
    await page.getByText('Not available yet').waitFor();
    return;
  }
  await page.getByLabel('Name Required').waitFor();
  if (state === 'ONB-11') {
    await page.getByLabel('Name Required').fill('');
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  if (state.startsWith('ONB-15')) {
    await page.getByRole('button', { name: 'Continue' }).click();
    if (state === 'ONB-15-saving') await page.getByText('Saving your answer').waitFor();
    if (state === 'ONB-15-failed') await page.getByText('Nothing was saved').waitFor();
    if (state === 'ONB-15-unknown') await page.getByText('Save status unknown').waitFor();
  }
}

async function capture(browser, width, state) {
  const page = await browser.newPage({
    viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce',
  });
  await page.route('**/*', serve.bind(null, state));
  try {
    await page.goto(`${origin}/welcome/survey`);
    await prepare(page, state);
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${state} overflow at ${width}px`);
    const back = page.getByRole('link', { name: 'Back to workspace' });
    const backBounds = await back.boundingBox();
    assert(backBounds && backBounds.x >= 0 && backBounds.x + backBounds.width <= width,
      `${state} Back is clipped at ${width}px`);
    const small = await page.locator('button:visible, input:visible, a:visible')
      .evaluateAll(controls => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.outerHTML.slice(0, 80)));
    assert.deepEqual(small, [], `${state} targets meet 44px at ${width}px`);
    const filename = `${state}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const states = ['ONB-10', 'ONB-11', 'ONB-12', 'ONB-15-saving', 'ONB-15-failed',
    'ONB-15-unknown', 'ONB-16', 'ONB-17-loading', 'ONB-17-unavailable',
    'ONB-17-recovered'];
  const filenames = [];
  for (const width of [1280, 390]) {
    for (const state of states) filenames.push(await capture(browser, width, state));
  }
  console.log(`Captured ${filenames.join(', ')}`);
} finally {
  await browser.close();
}
