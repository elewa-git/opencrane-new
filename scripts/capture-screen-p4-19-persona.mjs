import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const editCapture = process.env.PERSONA_EDIT_CAPTURE === '1';
const output = resolve(editCapture ? 'docs/process/screen-p4-19-edit'
  : 'docs/process/screen-p4-19-persona');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-19-persona.opencrane.test';
const revisionId = 'saved-revision-two';
const replacement = 'Call me Alex. Be direct and brief. Cite sources when needed. '
  + 'Keep my habits private; these wishes cannot change access or budgets.';

function progress(state, currentRevision = 2) {
  const savedSteps = state === 'absent' ? [1, 2, 3] : [1, 2, 3, 4];
  const steps = savedSteps.map(step => ({
    time: '2026-10-14T09:30:00.000Z', answers: { step },
  }));
  const approval = state === 'approved' || state === 'restart' ? { revision: 2, revisionId,
    time: '2026-10-14T09:35:00.000Z' } : null;
  return { state: 'review', survey: { generation: 1, position: 6,
    nextStep: null, steps }, currentRevision: state === 'absent' ? null : currentRevision,
    approval };
}

async function serve(scenario, route) {
  const { state, currentRevision } = scenario;
  const url = new URL(route.request().url());
  if (url.pathname === '/api/onboarding/welcome') {
    await route.fulfill({ json: { status: 'not_started', assistantAssigned: true } });
    return;
  }
  if (url.pathname === '/api/onboarding') {
    if (state === 'denied' || state === 'unavailable') {
      const status = state === 'denied' ? 403 : 503;
      await route.fulfill({ status, json: { status: state } });
      return;
    }
    await route.fulfill({ json: progress(state, currentRevision) });
    return;
  }
  if (url.pathname === '/api/onboarding/persona/revisions') {
    await route.fulfill({ json: { currentRevision: state === 'stale' ? 3 : currentRevision,
      revisions: [{ revision: currentRevision,
        revisionId: currentRevision === 2 ? revisionId : 'saved-revision-three' }] } });
    return;
  }
  if (url.pathname.startsWith('/api/onboarding/persona/revisions/')) {
    const currentId = currentRevision === 2 ? revisionId : 'saved-revision-three';
    const currentText = currentRevision === 2 ? replacement : 'Other device persona r3';
    await route.fulfill({ json: { revision: currentRevision, revisionId: currentId,
      generation: 1, current: true, approved: state === 'approved', replacement: currentText } });
    return;
  }
  if (url.pathname === '/api/onboarding/persona' && route.request().method() === 'POST') {
    if (state === 'conflict') {
      scenario.currentRevision = 3;
      await route.fulfill({ status: 409, json: { status: 'conflict' } });
    } else {
      await route.fulfill({ status: 503, json: { status: 'unknown' } });
    }
    return;
  }
  if (url.pathname === '/api/onboarding/survey' && route.request().method() === 'POST') {
    const command = route.request().postDataJSON();
    await route.fulfill({ json: { status: 'confirmed',
      operation: 'onboarding.survey_restarted', commandId: command.commandId } });
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
  const scenario = { state, currentRevision: 2 };
  const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce' });
  await page.route('**/*', serve.bind(null, scenario));
  try {
    await page.goto(`${origin}/welcome/persona`);
    const words = { review: replacement, approved: 'Approved revision r2',
      absent: 'No persona yet', stale: 'Proposal changed',
      denied: 'Your access has changed', unavailable: 'Persona service unavailable' };
    if (state === 'edit') {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator('textarea').fill(replacement + ' Follow my style.'.repeat(300));
      await page.getByRole('button', { name: 'Save as new revision' }).click();
      await page.getByText('Keep it under 4 KiB.').waitFor();
      const focused = await page.locator('textarea').evaluate(element =>
        element === element.ownerDocument.activeElement);
      assert(focused, 'The edit field keeps focus after a size error');
      await page.locator('textarea').evaluate(element => { element.scrollTop = 0; });
    } else if (state === 'conflict') {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator('textarea').fill('My unsaved words for this persona');
      await page.getByRole('button', { name: 'Save as new revision' }).click();
      await page.getByText('A newer revision exists').waitFor();
      assert.equal(await page.locator('textarea').inputValue(),
        'My unsaved words for this persona');
      await page.getByRole('alert').getByText('Other device persona r3').waitFor();
    } else if (state === 'restart') {
      await page.getByRole('button', { name: 'Restart survey' }).click();
      await page.waitForFunction('document.activeElement?.id === "restart-title"');
    } else if (state === 'restart-unapproved') {
      await page.getByRole('button', { name: 'Restart survey' }).click();
      await page.getByText('No persona is approved yet.', { exact: false }).waitFor();
    } else if (state === 'restarted-unapproved') {
      await page.getByRole('button', { name: 'Restart survey' }).click();
      await page.getByRole('dialog').getByRole('button',
        { name: 'Restart survey' }).click();
      await page.getByText('Survey restarted. No persona is approved yet.').waitFor();
    } else if (state === 'unknown') {
      await page.getByRole('button', { name: 'Approve this version' }).click();
      await page.getByText('Save status unknown.', { exact: false }).waitFor();
    } else {
      await page.getByText(words[state]).waitFor();
    }
    if (state === 'approved') {
      assert.equal(await page.locator('time').getAttribute('datetime'),
        '2026-10-14T09:35:00.000Z');
      assert.equal(await page.locator('a.button-link.approve').getAttribute('href'), '/welcome');
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
    if (editCapture && width === 390 && (state === 'edit' || state === 'restart')) {
      await page.setViewportSize({ width: 390, height: 500 });
      const actions = await page.getByRole('dialog').getByRole('button').all();
      for (const action of actions) {
        await action.scrollIntoViewIfNeeded();
        const bounds = await action.boundingBox();
        assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 500,
          'Dialog actions are reachable above a short phone viewport');
      }
    }
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    const states = editCapture
      ? ['edit', 'conflict', 'restart', 'restart-unapproved', 'restarted-unapproved',
        'absent', 'stale',
        'unknown', 'denied', 'unavailable']
      : ['review', 'approved', 'absent', 'stale', 'denied', 'unavailable'];
    for (const state of states) {
      await capture(browser, width, state);
    }
  }
} finally {
  await browser.close();
}
