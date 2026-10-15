import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const origin = 'https://memory-forget.opencrane.test';
const output = resolve('docs/process/screen-p4-13-forget');
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
  async function answer(route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body;
    let status = 200;
    if (path === '/api/memory/scopes') body = { scopes: [scope] };
    else if (path.endsWith('/facts/fact-one/forget')) {
      posts.push(JSON.parse(request.postData() || '{}'));
      if (scenario === 'conflict') { status = 409; body = { outcome: 'conflict' }; }
      else body = receipt('pending');
    } else if (path.includes('/changes/')) body = receipt('forgotten');
    else if (path.endsWith('/facts/fact-one')) {
      body = { scopeId: scope.scopeId, fact, sources: [], canForget: true };
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
}

const browser = await chromium.launch();
try {
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) await captureWidth(browser, width);
  await writeFile(`${output}/receipt.md`, `# Personal memory forget screen receipt\n\n` +
    `PASS: intercepted memory replies at 1280px and 390px with reduced motion.\n` +
    `Captured detail, review, pending, forgotten and conflict. The review showed no fact text.\n` +
    `After acceptance, the fact text was absent from the page. Each confirmation sent one POST.\n` +
    `Visible dialog buttons were at least 44px high. No horizontal overflow, browser storage\n` +
    `or fact id in the address was found. No dev stack or live journey was run.\n`);
  console.log('PASS Personal memory forget screen captures');
} finally { await browser.close(); }
