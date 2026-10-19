import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { approvalCard } from './approval-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { outline, pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p3-14-stop');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p3-14-stop.opencrane.test';
const resetAt = '2026-11-01T00:00:00Z';
const frames = [
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

function statusFor(frame) {
  if (frame.unavailable) return undefined;
  const reason = { scope: frame.scope, period: 'monthly', cause: 'bound_refused',
    resetAt, remedy: 'ask_admin_or_wait' };
  if (!frame.participant) reason.limitCents = 20000;
  return {
    status: 'stopped', stopId: 'fixture-stop', calls: [], reasons: [reason],
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
    await chatFixture(page, frame.scenario, optionsFor(frame));
    await page.route('**/api/conversations/*/budget-stops?*', async route => {
      budgetReads.push(route.request().method());
      if (frame.unavailable) {
        await route.fulfill({ status: 503, json: {} });
      } else {
        await route.fulfill({ json: statusFor(frame) });
      }
    });
    await page.goto(`${origin}/workspace?conversation=chat`);
    const notice = page.locator('oc-budget-stop-notice');
    await notice.waitFor();
    if (frame.unavailable) {
      await notice.getByText('Stop details unavailable').waitFor();
      const retry = notice.getByRole('button', { name: 'Check again' });
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
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const small = await page.locator('.navigation-toggle:visible, #panel-toggle:visible, '
      + 'oc-budget-stop-notice button:visible').evaluateAll(smallTargets);
    assert.deepEqual(small, [], 'Visible controls are at least 44px');
    assert.deepEqual(budgetReads, ['GET']);
    assert.equal(await notice.getByRole('alert').count(), 0);
    const filename = `${frame.name}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
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
  await writeFile(`${output}/receipt.md`, receipt);
  console.log(`Captured ${filenames.length} spending stop screens`);
} finally {
  await browser.close();
}
