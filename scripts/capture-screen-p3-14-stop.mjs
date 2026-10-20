import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { approvalCard } from './approval-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { outline, pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const callsSet = process.argv.includes('--calls');
const screenSet = callsSet ? 'screen-p3-14-calls' : 'screen-p3-14-stop';
const output = resolve(`docs/process/${screenSet}`);
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p3-14-stop.opencrane.test';
const resetAt = '2026-11-01T00:00:00Z';
const stopFrames = [
  { name: 'WRK-40', scenario: 'budget-group', scope: 'paying_group', execution: 'not_started' },
  { name: 'WRK-41', scenario: 'budget-global', scope: 'global', execution: 'stopping' },
  { name: 'WRK-42', scenario: 'budget-assistant', scope: 'assistant', execution: 'ended' },
  { name: 'SPD-54', scenario: 'budget-participant', scope: 'paying_group', execution: 'ended',
    participant: true },
  { name: 'WRK-44', scenario: 'budget-approval', scope: 'paying_group', execution: 'ended',
    approval: true },
  { name: 'WRK-45', scenario: 'budget-recovery', scope: 'paying_group', execution: 'ended',
    afterReset: true },
  { name: 'unavailable', scenario: 'budget-unavailable', scope: 'paying_group',
    execution: 'ended', unavailable: true },
];

const callFrames = [
  { name: 'WRK-43', scenario: 'budget-calls', scope: 'paying_group', execution: 'ended' },
  { name: 'participant', scenario: 'budget-participant', scope: 'paying_group',
    execution: 'ended', participant: true },
  { name: 'changed-status', scenario: 'budget-calls', scope: 'paying_group',
    execution: 'ended', changed: true },
  { name: 'unavailable', scenario: 'budget-calls', scope: 'paying_group',
    execution: 'ended', failedCheck: true },
];
const frames = callsSet ? callFrames : stopFrames;

function callsFor(frame) {
  if (!callsSet) return [];
  const reference = 'original-call-' + 'r'.repeat(180);
  if (frame.changed) return [{ reference, status: 'charged', chargedCents: 25 }];
  if (frame.participant) return [{ reference, status: 'possibly_sent' }];
  return [{ reference, status: 'possibly_sent', heldCents: 40 }];
}

function statusFor(frame) {
  if (frame.unavailable) return undefined;
  const reason = { scope: frame.scope, period: 'monthly', cause: 'bound_refused',
    resetAt, remedy: 'ask_admin_or_wait' };
  if (!frame.participant) reason.limitCents = 20000;
  return {
    status: 'stopped', stopId: 'fixture-stop', calls: callsFor(frame), reasons: [reason],
    work: [{ turnId: 'event-2', execution: frame.execution }],
    positions: { stop: 3, turn: 4, conversation: 5, computer: 6, budget: 7 },
  };
}

function optionsFor(frame) {
  const options = { budgetStatus: statusFor(frame) };
  if (frame.approval) {
    options.approvalCards = [{ ...approvalCard(0, 'cancelled', false), turnId: 'event-2' }];
  }
  return options;
}

function smallTargets(elements) {
  const small = [];
  for (const element of elements) {
    const bounds = element.getBoundingClientRect();
    if (bounds.width < 44 || bounds.height < 44) {
      small.push({ name: element.getAttribute('aria-label') || element.textContent,
        width: bounds.width, height: bounds.height });
    }
  }
  return small;
}

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

async function capture(browser, frame, width) {
  const height = frame.approval && width === 390 ? 1450 : 900;
  const page = await browser.newPage({ viewport: { width, height },
    reducedMotion: 'reduce' });
  const budgetReads = [];
  try {
    if (frame.afterReset) {
      await page.clock.install({ time: new Date('2026-11-02T10:00:00Z') });
    }
    await page.route(`${origin}/**`, serveAssets);
    const fixture = await chatFixture(page, frame.scenario, optionsFor(frame));
    async function readStop(route) {
      budgetReads.push(route.request().method());
      const address = new URL(route.request().url());
      assert.equal(address.pathname, '/api/conversations/chat/budget-stops');
      assert.equal(address.searchParams.get('turnId'), 'event-2');
      if (frame.failedCheck && budgetReads.length > 1) {
        await route.fulfill({ status: 503, json: {} });
      } else if (frame.changed && budgetReads.length === 1) {
        await route.fulfill({ json: statusFor({ ...frame, changed: false }) });
      } else if (frame.unavailable) {
        await route.fulfill({ status: 503, json: {} });
      } else {
        await route.fulfill({ json: statusFor(frame) });
      }
    }
    await page.route('**/api/conversations/*/budget-stops?*', readStop);
    await page.goto(`${origin}/workspace?conversation=chat`);
    const notice = page.locator('oc-budget-stop-notice');
    await notice.waitFor();
    if (frame.unavailable) {
      await notice.getByText('Stop details unavailable').waitFor();
      const retry = notice.getByRole('button', { name: 'Check status' });
      await retry.focus();
      assert.deepEqual(await retry.evaluate(outline), ['2px', 'rgb(10, 132, 151)', '2px']);
    } else {
      const name = { global: 'Organisation', paying_group: 'Group',
        assistant: 'Assistant' }[frame.scope];
      await notice.getByText(`${name} monthly limit reached`, { exact: false }).waitFor();
      if (frame.participant) assert(!(await notice.innerText()).includes('€'));
      if (frame.afterReset) {
        await notice.getByText('new monthly limit', { exact: false }).waitFor();
        const restart = page.getByRole('button', { name: /^(Retry|Resume)$/u });
        assert.equal(await restart.count(), 0, 'The stopped turn has no restart action');
      }
    }
    if (frame.approval) {
      await page.getByText("Can't continue", { exact: true }).waitFor();
      assert.equal(await page.locator('.approval-ledger').count(), 1);
      assert((await page.locator('.approval-ledger').innerText()).includes('Draft order SO-1042'));
      assert((await page.locator('oc-approval-cards').innerText()).includes(
        "This work stopped at the limit. Approving now wouldn't restart it."));
      assert.equal(await page.getByRole('button', { name: /^Approve/ }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /^Deny/ }).count(), 0);
    }
    if (callsSet) await checkSavedCalls(page, notice, frame, budgetReads);
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const small = await page.locator('.navigation-toggle:visible, #panel-toggle:visible, '
      + 'oc-budget-stop-notice button:visible').evaluateAll(smallTargets);
    assert.deepEqual(small, [], 'Visible controls are at least 44px');
    const expectedReads = callsSet ? ['GET', 'GET'] : ['GET'];
    assert.deepEqual(budgetReads, expectedReads);
    assert.equal(await notice.getByRole('alert').count(), 0);
    assert.deepEqual(fixture.commands, [], 'No work is sent or repeated');
    assert(await page.evaluate(hasNoSavedCallDetails), 'Call details stay out of storage');
    assert.equal(page.url(), `${origin}/workspace?conversation=chat`);
    const filename = `${frame.name}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

function callFitsViewport(element) {
  const bounds = element.getBoundingClientRect();
  return element.scrollWidth <= element.clientWidth
    && bounds.left >= 0 && bounds.right <= innerWidth;
}

function statusCheckFinished() {
  const action = document.querySelector('oc-budget-stop-notice button');
  return action?.getAttribute('aria-disabled') === 'false';
}

function hasFocus(element) {
  return element === document.activeElement;
}

function hasNoSavedCallDetails() {
  const saved = JSON.stringify({ ...localStorage, ...sessionStorage });
  return !/original-call|heldCents|chargedCents|Reserved:|Pull the Q3/iu.test(saved);
}

async function checkSavedCalls(page, notice, frame, budgetReads) {
  const card = notice.locator('.budget-call');
  await card.getByText('Outcome unknown', { exact: true }).waitFor();
  assert.equal(await card.count(), 1);
  assert((await card.innerText()).includes('may have been sent'));
  if (!frame.participant) assert((await card.innerText()).includes('€0.40'));
  const action = notice.getByRole('button', { name: 'Check status', exact: true });
  await action.focus();
  assert.deepEqual(await action.evaluate(outline), ['2px', 'rgb(10, 132, 151)', '2px']);
  await action.press('Enter');
  if (frame.changed) {
    await card.getByText('Recorded charge', { exact: true }).waitFor();
    assert((await card.innerText()).includes('€0.25'));
    assert(!(await card.innerText()).includes('€0.40'));
  } else if (frame.failedCheck) {
    await notice.getByText('Stop details unavailable', { exact: true }).waitFor();
    assert((await card.innerText()).includes('Outcome unknown'));
  } else {
    await page.waitForFunction(statusCheckFinished);
  }
  assert.deepEqual(budgetReads, ['GET', 'GET']);
  assert(await action.evaluate(hasFocus));
  await notice.getByText('Group monthly limit reached', { exact: false }).waitFor();
  assert(await card.evaluate(callFitsViewport), 'Call card fits the screen');
  assert(await card.locator('code').evaluate(callFitsViewport), 'Reference wraps inside the card');
  if (frame.participant) assert(!(await notice.innerText()).includes('€'));
  assert.equal(await notice.getByRole('alert').count(), 0);
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const filenames = [];
  for (const width of [1280, 390]) {
    for (const frame of frames) filenames.push(await capture(browser, frame, width));
  }
  const receipt = '# Spending stop chat screens\n\n'
    + 'PASS: Intercepted chat replies were captured at 1280px and 390px with reduced motion. '
    + 'Each screen made one GET for its stop details and no write. '
    + 'No screen has horizontal overflow. Checked controls meet 44px, '
    + 'and the unavailable action has a 2px focus ring. '
    + 'The cancelled approval keeps its ledger and stop explanation without a decision action.\n\n'
    + `Captures: ${filenames.join(', ')}.\n`;
  let savedReceipt = receipt;
  if (callsSet) {
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    savedReceipt = '# Saved call status screens\n\n'
      + `Date: ${new Date().toISOString().slice(0, 10)}. Source: ${source} plus working changes.\n\n`
      + 'Environment: local Chromium with intercepted API replies; not a fresh installation. '
      + 'Command: `npm run visual:screen-p3-14-calls`. Expected and observed: '
      + 'saved status reads preserve the reason, wrap references and keep focus.\n\n'
      + 'PASS: Reduced-motion browser fixtures at 1280px and 390px. '
      + 'The reason stays visible; long references wrap and cards fit the screen. '
      + 'Check status uses the original turn GET, keeps keyboard focus and has a 44px target '
      + 'with a 2px focus ring. A failed check keeps the last status; participants see no amounts.\n\n'
      + 'NOT RUN: Fresh-install live journey. No stack or model call was used.\n\n'
      + `Captures: ${filenames.join(', ')}.\n`;
  }
  await writeFile(`${output}/receipt.md`, savedReceipt);
  console.log(`Captured ${filenames.length} spending stop screens`);
} finally {
  await browser.close();
}
