import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-20-list');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-20-list.opencrane.test';
const answer = 'A concise comparison of our two suppliers.';
const startedAt = '2026-10-14T09:02:00.000Z';
const completedAt = '2026-10-14T09:03:00.000Z';

function listRow(fixture) {
  return { kind: 'welcome', welcomeId: fixture.welcome.welcomeId, route: '/welcome',
    title: 'Welcome', createdAt: fixture.welcome.startedAt,
    activityAt: fixture.welcome.completedAt, unread: 0,
    archived: fixture.archived, archivePosition: fixture.archived ? 12 : 13 };
}

const assistantWelcome = { status: 'completed', welcomeId: 'assistant-welcome',
  scriptVersion: 'welcome-v1', variant: 'assistant', revision: 2,
  revisionId: 'saved-revision', assistantId: 'assistant-one', assignmentStatus: 'assigned',
  startedAt, completedAt, position: 13, answered: 1, nextStep: null,
  question: null, answer };

const noAssistantWelcome = { status: 'completed', welcomeId: 'no-assistant-welcome',
  scriptVersion: 'welcome-v1', variant: 'no_assistant', revision: null,
  revisionId: null, assistantId: null, assignmentStatus: 'not_requested',
  startedAt, completedAt, position: 13, answered: 1, nextStep: null,
  question: null, answer: 'Continue to workspace' };

async function serve(fixture, route) {
  const address = new URL(route.request().url());
  if (address.pathname === '/api/onboarding/welcome') {
    await route.fulfill({ json: fixture.welcome });
    return;
  }
  if (address.pathname === '/api/conversations') {
    const section = address.searchParams.get('section') ?? 'recent';
    const matches = address.searchParams.get('q')?.toLowerCase() ?? '';
    const selected = section === (fixture.archived ? 'archived' : 'recent');
    const rows = selected && 'welcome'.includes(matches) ? [listRow(fixture)] : [];
    await route.fulfill({ json: { rows, nextCursor: null } });
    return;
  }
  if (address.pathname === '/api/onboarding/welcome/archive') {
    const body = route.request().postDataJSON();
    assert.equal(body.welcomeId, fixture.welcome.welcomeId);
    fixture.archived = body.archived;
    await route.fulfill({ json: { status: 'confirmed', commandId: body.commandId,
      operation: 'onboarding.welcome_archive_set', position: 13,
      eventId: 'archive-event', time: completedAt } });
    return;
  }
  if (address.pathname.startsWith('/api/')) assert.fail(`Unexpected request: ${address.pathname}`);
  await serveWebBuild(route, build);
}

function smallActions(controls) {
  const small = [];
  for (const control of controls) {
    const box = control.getBoundingClientRect();
    if (box.width < 44 || box.height < 44) small.push(control.textContent?.trim());
  }
  return small;
}

async function checkPage(page, label, width) {
  await page.evaluate(waitForFonts);
  assert(await page.evaluate(pageHasNoOverflow), `${label} overflows at ${width}px`);
  const small = await page.locator('button:visible, a:visible').evaluateAll(smallActions);
  assert.deepEqual(small, [], `${label} has an action smaller than 44px at ${width}px`);
  await page.screenshot({ path: `${output}/${label}-${width}.png`, fullPage: true });
}

async function checkNoAssistantLayout(page, width) {
  const notice = await page.locator('.no-assistant-notice').boundingBox();
  const dock = await page.locator('.completed-dock').boundingBox();
  assert(notice && dock, 'No-assistant completion is missing');
  assert(notice.width >= 300, `No-assistant notice is too narrow at ${width}px`);
  assert(notice.x >= 0 && notice.x + notice.width <= width,
    `No-assistant notice passes the viewport at ${width}px`);
  assert(dock.y + dock.height <= (width === 390 ? 844 : 900),
    `No-assistant dock passes the viewport at ${width}px`);
}

async function capture(browser, width) {
  const fixture = { archived: true, welcome: assistantWelcome };
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: 'reduce' });
  await page.route('**/*', serve.bind(null, fixture));
  try {
    await page.goto(`${origin}/workspace/conversations?section=archived`);
    await page.getByRole('link', { name: /Completed welcome · Read-only Welcome/ }).waitFor();
    await checkPage(page, 'archived-list', width);
    await page.getByRole('link', { name: /Completed welcome · Read-only Welcome/ }).click();
    await page.getByText(answer).waitFor();
    await page.getByRole('button', { name: 'Restore to list' }).waitFor();
    assert.equal(await page.locator('textarea').count(), 0);
    if (width === 390) {
      const opener = page.getByRole('button', { name: 'Open navigation' });
      await opener.click();
      await page.getByRole('navigation', { name: 'Workspace navigation' })
        .getByRole('link', { name: 'Archived' }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await opener.evaluate(element => element === element.ownerDocument.activeElement), true);
    }
    await checkPage(page, 'archived-welcome', width);
    await page.getByRole('button', { name: 'Restore to list' }).click();
    await page.getByRole('button', { name: 'Archive welcome' }).waitFor();
    await page.getByText(answer).waitFor();
    await checkPage(page, 'restored-welcome', width);
    await page.getByRole('link', { name: 'Back to list' }).first().click();
    await page.getByRole('link', { name: /Completed welcome · Read-only Welcome/ }).waitFor();
    await checkPage(page, 'restored-list', width);
  } finally {
    await page.close();
  }

  const otherFixture = { archived: false, welcome: noAssistantWelcome };
  const otherPage = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: 'reduce' });
  await otherPage.route('**/*', serve.bind(null, otherFixture));
  try {
    await otherPage.goto(`${origin}/welcome`);
    await otherPage.getByText('No personal assistant assigned yet').waitFor();
    await otherPage.getByRole('link', { name: 'Message a colleague' }).waitFor();
    await otherPage.getByRole('link', { name: 'Message a group' }).waitFor();
    assert.equal(await otherPage.getByText(answer).count(), 0);
    assert.equal(await otherPage.locator('textarea').count(), 0);
    await checkNoAssistantLayout(otherPage, width);
    await checkPage(otherPage, 'no-assistant-welcome', width);
  } finally {
    await otherPage.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) await capture(browser, width);
} finally {
  await browser.close();
}
