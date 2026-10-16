import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-19-survey3');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-19-survey3.opencrane.test';
const name = { time: '2026-10-14T09:30:00.000Z',
  answers: { step: 1, preferredName: 'Alex', pronouns: null } };
const work = { time: '2026-10-14T09:31:00.000Z',
  answers: { step: 2, workDescription: 'I teach new colleagues.', groupIds: [] } };
const style = { time: '2026-10-14T09:32:00.000Z',
  answers: { step: 3, tone: 'direct', length: 'brief', citations: true } };
const tasks = { time: '2026-10-14T09:33:00.000Z',
  answers: { step: 4, tasks: ['draft_documents', 'compare_supplier_proposals'], ownTask: null } };

function progress(state) {
  let steps = [name, work, style];
  if (state === 'ONB-13' || state === 'ONB-16') steps = [name, work];
  if (state === 'complete') steps = [name, work, style, tasks];
  return { state: steps.length === 4 ? 'review' : 'survey', survey: {
    generation: 1, position: steps.length, nextStep: steps.length === 4 ? null : steps.length + 1,
    steps,
  } };
}

async function serve(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: true, user: { name: 'Alex' } } });
    return;
  }
  if (url.pathname === '/api/onboarding') {
    await route.fulfill({ json: progress(state) });
    return;
  }
  if (url.pathname === '/api/onboarding/survey') {
    if (state === 'ONB-15-saving') {
      await new Promise(() => {});
      return;
    }
    if (state === 'ONB-15-conflict') {
      await route.fulfill({ status: 409, json: { status: 'conflict' } });
      return;
    }
    const status = state === 'ONB-15-unknown' ? 'unknown' : 'unavailable';
    await route.fulfill({ status: 503, json: { status } });
    return;
  }
  if (url.pathname.startsWith('/api/')) assert.fail(`Unexpected request: ${url.pathname}`);
  await serveWebBuild(route, build);
}

async function prepare(page, state) {
  if (state === 'ONB-16') {
    await page.getByText('Steps 1–2 saved').waitFor();
    return;
  }
  if (state === 'ONB-13') {
    await page.getByText('How should I work with you?').waitFor();
    return;
  }
  if (state === 'complete') {
    await page.getByText('Your survey is saved').waitFor();
    return;
  }
  await page.getByText('What would you like help with?').waitFor();
  if (state === 'ONB-14' || state === 'ONB-14-long') {
    await page.getByRole('button', { name: 'Draft documents' }).click();
    await page.getByRole('button', { name: 'Compare supplier proposals' }).click();
    if (state === 'ONB-14-long') {
      await page.getByLabel('Your own task Optional').fill('Planning'.repeat(24));
      const bounds = await page.getByLabel('Your own task Optional').boundingBox();
      assert(bounds && bounds.height > 52, 'Long task text wraps onto another line');
    }
    return;
  }
  await page.getByRole('button', { name: 'Review persona' }).click();
  if (state === 'ONB-15-saving') await page.getByText('Saving your answer').waitFor();
  if (state === 'ONB-15-failed') await page.getByText('Nothing was saved').waitFor();
  if (state === 'ONB-15-conflict') {
    await page.getByText('Progress changed on another device').waitFor();
  }
  if (state === 'ONB-15-unknown') await page.getByText('Save status unknown').waitFor();
}

async function capture(browser, width, state) {
  const page = await browser.newPage({
    viewport: { width, height: width === 1280 ? 900 : 844 }, reducedMotion: 'reduce',
  });
  await page.route('**/*', serve.bind(null, state));
  try {
    await page.goto(`${origin}/welcome/survey`);
    await prepare(page, state);
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${state} overflows at ${width}px`);
    const selector = 'button:visible, input:not([type=checkbox]):visible, a:visible';
    const small = await page.locator(selector).evaluateAll(findSmallControls);
    assert.deepEqual(small, [], `${state} controls meet 44px at ${width}px`);
    const filename = `${state}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

function findSmallControls(controls) {
  const small = [];
  for (const control of controls) {
    const bounds = control.getBoundingClientRect();
    if (Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44) {
      small.push(control.outerHTML.slice(0, 80));
    }
  }
  return small;
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const states = ['ONB-13', 'ONB-14', 'ONB-14-long', 'ONB-15-saving', 'ONB-15-failed',
    'ONB-15-conflict',
    'ONB-15-unknown', 'ONB-16', 'complete'];
  for (const width of [1280, 390]) {
    for (const state of states) await capture(browser, width, state);
  }
} finally {
  await browser.close();
}
