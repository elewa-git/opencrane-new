import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { approvalCard, approvalFixture } from './approval-fixture.mjs';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { captureWaitingApproval } from '../infra/dev-stack/stage-b-capture.ts';

const output = resolve(process.argv[2] ?? '/tmp/stage-b-polish-captures');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://stage-b-polish.opencrane.test';

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

async function checkDrawer(browser, width, toolReplied) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  try {
    await page.route(`${origin}/**`, serveAssets);
    const chat = await chatFixture(page, 'approval-context');
    const card = { ...approvalCard(0, 'outcome_unknown', false, chat.memberId),
      toolReplied, canRetry: false,
      requestedAt: '2026-10-04T10:14:00Z', decidedAt: '2026-10-04T10:16:00Z',
      usedAt: '2026-10-04T10:17:00Z' };
    await approvalFixture(page, { cards: [card] });
    await page.goto(`${origin}/workspace?conversation=chat`);
    await page.locator('.approval-terminal').click();
    const drawer = page.getByRole('dialog');
    const message = toolReplied ? 'Done: the tool replied' : 'Result not confirmed';
    await drawer.getByText(message, { exact: true }).waitFor();
    const text = await drawer.innerText();
    const absent = toolReplied ? 'Result not confirmed' : 'Done: the tool replied';
    assert(!text.includes(absent));
    assert(text.includes('can’t be reused'));
    const fits = await drawer.evaluate(drawerFits);
    assert(fits, 'The drawer fits the screen width');
    const state = toolReplied ? 'replied' : 'unknown';
    await page.screenshot({ path: `${output}/${state}-${width}.png`, fullPage: true });
  } finally {
    await page.close();
  }
}

function drawerFits(drawer) {
  const bounds = drawer.getBoundingClientRect();
  return bounds.left >= 0 && bounds.right <= globalThis.innerWidth &&
    drawer.scrollWidth <= drawer.clientWidth;
}

async function checkWaiting(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.route(`${origin}/**`, serveAssets);
    const chat = await chatFixture(page, 'approval-context');
    const card = approvalCard(0, 'requested', true, chat.memberId);
    await approvalFixture(page, { cards: [card] });
    await page.goto(`${origin}/workspace?conversation=chat`);
    await captureWaitingApproval(page, output, 'waiting');
    await page.reload();
    await captureWaitingApproval(page, output, 'waiting-reloaded');
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const toolReplied of [true, false]) {
      await checkDrawer(browser, width, toolReplied);
    }
  }
  await checkWaiting(browser);
  console.log(`PASS: both drawer results and complete waiting cards at 1280 and 390; ${output}`);
} finally {
  await browser.close();
}
