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

function listRow(archived) {
  return { kind: 'welcome', welcomeId: 'saved-welcome', route: '/welcome',
    title: 'Welcome', createdAt: startedAt, activityAt: completedAt, unread: 0,
    archived, archivePosition: archived ? 12 : 13 };
}

function savedWelcome(noAssistant) {
  return { status: 'completed', welcomeId: 'saved-welcome', scriptVersion: 'welcome-v1',
    variant: noAssistant ? 'no_assistant' : 'assistant',
    revision: noAssistant ? null : 2, revisionId: noAssistant ? null : 'saved-revision',
    assistantId: noAssistant ? null : 'assistant-one',
    assignmentStatus: noAssistant ? 'not_requested' : 'assigned',
    startedAt, completedAt, position: 13, answered: 1, nextStep: null,
    question: null, answer: noAssistant ? 'Continue to workspace' : answer };
}

async function serve(fixture, route) {
  const address = new URL(route.request().url());
  if (address.pathname === '/api/onboarding/welcome') {
    await route.fulfill({ json: savedWelcome(fixture.noAssistant) });
    return;
  }
  if (address.pathname === '/api/conversations') {
    const section = address.searchParams.get('section') ?? 'recent';
    const matches = address.searchParams.get('q')?.toLowerCase() ?? '';
    const selected = section === (fixture.archived ? 'archived' : 'recent');
    const rows = selected && 'welcome'.includes(matches) ? [listRow(fixture.archived)] : [];
    await route.fulfill({ json: { rows, nextCursor: null } });
    return;
  }
  if (address.pathname === '/api/onboarding/welcome/archive') {
    const body = route.request().postDataJSON();
    assert.equal(body.welcomeId, 'saved-welcome');
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

async function capture(browser, width) {
  const fixture = { archived: true, noAssistant: false };
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
    await checkPage(page, 'restored-welcome', width);
    await page.getByRole('link', { name: 'Back to list' }).first().click();
    await page.getByRole('link', { name: /Completed welcome · Read-only Welcome/ }).waitFor();
    await checkPage(page, 'restored-list', width);

    fixture.noAssistant = true;
    await page.goto(`${origin}/welcome`);
    await page.getByRole('link', { name: 'Message a colleague' }).waitFor();
    await page.getByRole('link', { name: 'Message a group' }).waitFor();
    assert.equal(await page.getByText(answer).count(), 0);
    assert.equal(await page.locator('textarea').count(), 0);
    await checkPage(page, 'no-assistant-welcome', width);
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) await capture(browser, width);
} finally {
  await browser.close();
}
