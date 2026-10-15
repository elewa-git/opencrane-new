import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-19-survey2');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-19-survey2.opencrane.test';
const savedStep = {
  status: 'confirmed', commandId: 'saved', eventId: 'event',
  operation: 'onboarding.survey_step_saved', position: 1,
  time: '2026-10-14T09:30:00.000Z',
  answers: { step: 1, preferredName: 'Alex', pronouns: null },
};
const savedProgress = {
  state: 'survey', allowedActions: ['save_step', 'restart'], recentReceipts: [savedStep],
  survey: { generation: 1, position: 1, nextStep: 2, steps: [savedStep] },
};
const secondStep = { time: '2026-10-14T09:31:00.000Z',
  answers: { step: 2, workDescription: 'I teach new colleagues.', groupIds: ['group-a'] } };
const resumedProgress = {
  state: 'survey',
  survey: { generation: 1, position: 2, nextStep: 3, steps: [savedStep, secondStep] },
};
const laterProgress = {
  state: 'survey', survey: { generation: 1, position: 4, nextStep: null,
    steps: [savedStep, secondStep,
      { time: '2026-10-14T09:32:00.000Z', answers: { step: 3, style: 'Brief' } },
      { time: '2026-10-14T09:33:00.000Z', answers: { step: 4, tasks: 'Planning' } }],
  },
};

async function serve(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: true, user: { name: 'Alex' } } });
    return;
  }
  if (url.pathname === '/api/onboarding') {
    let progress = savedProgress;
    if (state === 'ONB-16' || state === 'ONB-12-groups-changed') {
      progress = resumedProgress;
    }
    if (state === 'ONB-12-later-steps') progress = laterProgress;
    await route.fulfill({ json: progress });
    return;
  }
  if (url.pathname === '/api/chat/groups') {
    if (state === 'ONB-12-groups-failed') {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    const changed = state === 'ONB-12-groups-changed';
    await route.fulfill({ json: { rows: [{ groupId: changed ? 'group-b' : 'group-a',
      name: changed ? 'Editors' : 'Teachers' }],
      next: null } });
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
  if (state === 'ONB-12-later-steps') {
    await page.getByText('Step 4 of 4').waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByText('Teachers').waitFor();
    await page.getByLabel('Your work Required').fill('I mentor new colleagues.');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Save and review later steps' }).waitFor();
    return;
  }
  if (state === 'ONB-12-groups-changed') {
    await page.getByText('Step 3 of 4').waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByText('Editors').waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Replace saved groups' }).waitFor();
    return;
  }
  if (state === 'ONB-16') {
    await page.getByText('Steps 1–2 saved').waitFor();
    return;
  }
  if (state === 'ONB-12-groups-failed') {
    await page.getByText('Your groups could not be loaded').waitFor();
    return;
  }
  await page.getByLabel('Your work Required').waitFor();
  await page.getByText('Teachers').waitFor();
  if (state === 'ONB-12') {
    await page.getByLabel('Your work Required').fill('I teach new colleagues.');
  }
  if (state === 'ONB-12-byte-error') {
    await page.getByLabel('Your work Required').fill('界'.repeat(1366));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#work-error').waitFor();
  }
  if (state.startsWith('ONB-15')) {
    await page.getByLabel('Your work Required').fill('I teach new colleagues.');
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
  const states = ['ONB-12', 'ONB-12-byte-error', 'ONB-12-groups-failed',
    'ONB-12-later-steps', 'ONB-12-groups-changed',
    'ONB-15-saving', 'ONB-15-failed', 'ONB-15-unknown', 'ONB-16'];
  const filenames = [];
  for (const width of [1280, 390]) {
    for (const state of states) filenames.push(await capture(browser, width, state));
  }
  console.log(`Captured ${filenames.join(', ')}`);
} finally {
  await browser.close();
}
