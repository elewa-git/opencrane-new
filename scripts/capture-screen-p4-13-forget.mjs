import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const editing = process.argv.includes('--edit');
const origin = 'https://memory-forget.opencrane.test';
const output = resolve(editing ? 'docs/process/screen-p4-13-edit' :
  'docs/process/screen-p4-13-forget');
const build = resolve('apps/web/dist/web/browser');
const fact = { memoryId: 'fact-one', revision: 3,
  text: 'The quarterly planning session is usually held on Thursday.',
  kind: 'fact', pinned: false, expiresAt: null, savedAt: '2026-10-02T10:00:00Z' };
const scope = { scopeId: 'scope-person', scopeKind: 'person', ownerId: 'me',
  audience: { kind: 'person', ownerId: 'me' }, canRead: true, canForget: true };

function receipt(cleanupStatus) {
  return { operation: 'forget', outcome: 'accepted', hidden: true, cleanupStatus,
    scopeId: scope.scopeId, memoryId: fact.memoryId, revision: 4,
    forgottenAt: '2026-10-04T09:20:00Z' };
}

async function serveMemory(page, scenario, posts) {
  let detailReads = 0;
  async function answer(route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body;
    let status = 200;
    if (path.endsWith('/correct')) {
      posts.push(JSON.parse(request.postData() || '{}'));
      if (scenario !== 'accepted') { status = 409; body = { outcome: 'conflict' }; }
      else body = { operation: 'correct', outcome: 'accepted', scopeId: scope.scopeId,
        memoryId: fact.memoryId, revision: 4, acceptedAt: '2026-10-20T09:20:00Z',
        contentStatus: 'current', cleanupStatus: 'pending' };
    } else if (path === '/api/memory/scopes') body = { scopes: [scope] };
    else if (path.endsWith('/facts/fact-one/forget')) {
      posts.push(JSON.parse(request.postData() || '{}'));
      if (scenario === 'conflict' || scenario === 'forgotten-detail') {
        status = 409;
        body = { outcome: 'conflict' };
      }
      else body = receipt('pending');
    } else if (path.includes('/changes/')) body = receipt('forgotten');
    else if (path.endsWith('/facts/fact-one')) {
      detailReads += 1;
      if (['forgotten-detail', 'unavailable'].includes(scenario) && detailReads > 1) {
        let reason = 'forgotten';
        if (scenario === 'unavailable') reason = 'quarantined';
        body = { status: 'unavailable', scopeId: scope.scopeId, memoryId: fact.memoryId,
          revision: 4, reason };
      } else {
        let current = fact;
        if (editing && detailReads > 1) current = { ...fact, revision: 4,
          text: 'The quarterly planning session is now held on Friday.' };
        body = { scopeId: scope.scopeId, fact: current, sources: [], canForget: true,
          canCorrect: editing };
      }
    } else {
      body = { scopeId: scope.scopeId, facts: [fact], returnedCount: 1, nextCursor: null };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body),
      headers: { 'cache-control': 'no-store' } });
  }
  await page.route('**/api/memory/**', answer);
}

async function openDetail(page, width) {
  if (width === 390) await page.locator('#panel-toggle').click();
  await page.getByRole('tab', { name: /Memory/ }).click();
  await page.getByRole('button', { name: /quarterly planning session/ }).click();
  await page.getByRole('dialog', { name: 'Fact details' }).getByRole('button', {
    name: 'Forget', exact: true,
  }).waitFor();
}

async function inspect(page, width) {
  assert(await page.evaluate(pageHasNoOverflow), `Horizontal overflow at ${width}px`);
  const shortTargets = await page.locator('dialog[open] button:visible')
    .evaluateAll(countShortButtons);
  assert.equal(shortTargets, 0, `A visible dialog button is shorter than 44px at ${width}px`);
}

function countShortButtons(buttons) {
  let count = 0;
  for (const button of buttons) {
    if (button.getBoundingClientRect().height < 44) count += 1;
  }
  return count;
}

async function capture(page, name, width) {
  await inspect(page, width);
  await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
}

async function openPage(browser, width, scenario, posts) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: 'reduce' });
  await page.route(`${origin}/**`, serveBuild);
  await chatFixture(page, 'private-team-draft');
  await serveMemory(page, scenario, posts);
  await page.goto(`${origin}/workspace?conversation=chat`);
  await page.evaluate(waitForFonts);
  await openDetail(page, width);
  return page;
}

async function serveBuild(route) { await serveWebBuild(route, build); }
function focusedText() { return globalThis.document.activeElement?.textContent?.trim(); }
function headingHasFocus() { return globalThis.document.activeElement?.id === 'memory-title'; }
function storageCount() { return globalThis.localStorage.length + globalThis.sessionStorage.length; }
function enterSearch(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function assertFactHidden(page) {
  assert.equal(await page.locator('.search input').inputValue(), '');
  const results = await page.locator('.results').textContent();
  assert(!results.includes(fact.text), 'The list still contains forgotten text');
  const liveRegions = await page.locator('[aria-live], [role="status"], [role="alert"]')
    .allTextContents();
  for (const region of liveRegions) {
    assert(!region.includes(fact.text), 'A live region still contains forgotten text');
  }
}

async function captureWidth(browser, width) {
  const posts = [];
  const page = await openPage(browser, width, 'accepted', posts);
  try {
    await capture(page, 'MEM-20', width);
    await page.getByRole('dialog', { name: 'Fact details' }).getByRole('button', {
      name: 'Forget', exact: true,
    }).click();
    const review = page.getByRole('dialog', { name: 'Forget this fact from your memory?' });
    await review.waitFor();
    assert(!(await review.textContent()).includes(fact.text));
    await capture(page, 'MEM-40', width);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Forget this fact from your memory?' }).waitFor({
      state: 'hidden',
    });
    const focused = await page.evaluate(focusedText);
    assert.equal(focused, 'Forget', 'Escape returns focus to Forget');
    await page.getByRole('button', { name: 'Forget', exact: true }).click();
    await review.waitFor();
    await review.getByRole('button', { name: 'Forget from your memory' }).click();
    await page.getByText('Hidden · cleanup pending').waitFor();
    await page.waitForFunction(headingHasFocus);
    assert(!(await page.locator('body').textContent()).includes(fact.text));
    await capture(page, 'MEM-41-pending', width);
    await page.getByRole('button', { name: 'Check status' }).click();
    await page.getByText('Forgotten', { exact: true }).waitFor();
    await capture(page, 'MEM-41-forgotten', width);
    assert.equal(posts.length, 1, 'One confirmation sends one command');
    assert(!page.url().includes(fact.memoryId));
    const storage = await page.evaluate(storageCount);
    assert.equal(storage, 0, 'Memory stays out of browser storage');
  } finally { await page.close(); }

  const conflictPosts = [];
  const conflictPage = await openPage(browser, width, 'conflict', conflictPosts);
  try {
    await conflictPage.getByRole('button', { name: 'Forget', exact: true }).click();
    await conflictPage.getByRole('button', { name: 'Forget from your memory' }).click();
    await conflictPage.getByText('Changed before you forgot it').waitFor();
    await capture(conflictPage, 'MEM-41-conflict', width);
    assert.equal(conflictPosts.length, 1);
  } finally { await conflictPage.close(); }

  const searchedPage = await openPage(browser, width, 'accepted', []);
  try {
    await searchedPage.locator('.search input').evaluate(enterSearch, fact.text);
    await searchedPage.getByRole('button', { name: 'Forget', exact: true }).click();
    await searchedPage.getByRole('button', { name: 'Forget from your memory' }).click();
    await searchedPage.getByText('Hidden · cleanup pending').waitFor();
    await assertFactHidden(searchedPage);
    await capture(searchedPage, 'MEM-42-search-cleared', width);
  } finally { await searchedPage.close(); }

  const forgottenPage = await openPage(browser, width, 'forgotten-detail', []);
  try {
    await forgottenPage.getByRole('button', { name: 'Forget', exact: true }).click();
    await forgottenPage.getByRole('button', { name: 'Forget from your memory' }).click();
    await forgottenPage.getByText('Changed before you forgot it').waitFor();
    await forgottenPage.getByRole('button', { name: 'Review latest revision' }).click();
    await forgottenPage.getByText('This fact or its text is no longer available.').waitFor();
    await assertFactHidden(forgottenPage);
    await capture(forgottenPage, 'MEM-43-review-hidden', width);
  } finally { await forgottenPage.close(); }
}

async function captureEditWidth(browser, width) {
  for (const scenario of ['accepted', 'conflict', 'forgotten-detail', 'unavailable']) {
    const posts = [];
    const page = await openPage(browser, width, scenario, posts);
    try {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Edit fact', exact: true });
      await sheet.getByRole('textbox').fill('The planning session is now on Friday.');
      if (scenario === 'accepted') await capture(page, 'MEM-33', width);
      await sheet.getByRole('button', { name: 'Save correction' }).click();
      if (scenario === 'accepted') {
        await page.getByText('Corrected in your memory · r4').waitFor();
        await page.locator('.detail-text').filter({ hasText: 'now held on Friday' }).waitFor();
        await capture(page, 'MEM-34', width);
        const receipt = await page.locator('.edit-receipt').textContent();
        assert(!receipt.includes(fact.text));
      } else {
        await sheet.getByText('This fact changed before your edit was saved').waitFor();
        if (scenario === 'forgotten-detail') {
          await sheet.getByRole('button', { name: 'Refresh and review' }).click();
          await sheet.getByText('This fact was forgotten. Your edit wasn’t applied.').waitFor();
          assert.equal(await page.locator('oc-memory-edit textarea').count(), 0);
          await assertFactHidden(page);
        }
        if (scenario === 'unavailable') {
          await sheet.getByRole('button', { name: 'Refresh and review' }).click();
          const unavailableMessage = sheet.getByText(
            'This fact’s text is no longer available. Your edit wasn’t applied.');
          await unavailableMessage.waitFor();
          const sheetText = await sheet.textContent();
          assert(!sheetText.includes('forgotten'));
          const fields = page.locator('oc-memory-edit textarea');
          assert.equal(await fields.count(), 0);
          const rows = page.locator('button.fact');
          assert.equal(await rows.count(), 1);
        }
        await capture(page, `MEM-35-${scenario}`, width);
      }
      assert.equal(posts.length, 1);
      assert.equal(await page.evaluate(storageCount), 0);
      assert(!page.url().includes(fact.memoryId));
    } finally { await page.close(); }
  }
}

const browser = await chromium.launch();
try {
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    if (editing) await captureEditWidth(browser, width);
    else await captureWidth(browser, width);
  }
  await writeFile(`${output}/receipt.md`, editing ? `# Personal memory correction screens

` +
    `PASS: intercepted replies at 1280px and 390px, reduced motion. Captured edit,
` +
    `accepted receipt, conflict, forgotten and unavailable detail. One POST per save. Receipts
` +
    `held no fact text; forgotten text left inputs, rows and announcements. Unavailable detail kept its row.
` +
    `Dialog actions were at least 44px; no horizontal overflow, browser storage or address change.
` +
    `The desktop editor keeps the shared centred ModalSheet, as the forget sheet does.
` +
    `The reference uses a right-hand drawer. That cross-screen change is deferred.
` +
    `MEM-35 messages use plain status text without the reference alert-card style.
` +
    `NOT RUN: fresh-install journey, real keyboard and assistive technology. No dev stack or model call.
` +
    `Source base: ${process.env['SCREEN_SOURCE_SHA'] || 'working tree'}, with working-tree edits; date: ${new Date().toISOString()}.
` :
    `# Personal memory forget screen receipt\n\n` +
    `PASS: intercepted memory replies at 1280px and 390px with reduced motion.\n` +
    `Captured detail, review, pending, forgotten, conflict, searched acceptance and a\n` +
    `forgotten detail after conflict. The review showed no fact text. Search input, list\n` +
    `and live regions held no forgotten text after either hidden outcome.\n` +
    `Each confirmation sent one POST.\n` +
    `Visible dialog buttons were at least 44px high. No horizontal overflow, browser storage\n` +
    `or fact id in the address was found. No dev stack or live journey was run.\n`);
  console.log(editing ? 'PASS Personal memory correction screen captures' :
    'PASS Personal memory forget screen captures');
} finally { await browser.close(); }
