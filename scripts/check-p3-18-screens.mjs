import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { computerFixture } from './computer-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';

const output = resolve('docs/process/p3-18-screens');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p3-18.opencrane.test';
const widths = [1280, 390, 320];
const captures = [];
const keys = [];
async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function transcriptReady() {
  return globalThis.document.querySelector('.transcript')?.getAttribute('aria-busy') !== 'true';
}

function pageHasNoHorizontalOverflow() {
  return globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth;
}

function previewFinishedLoading() {
  const state = globalThis.document.querySelector('oc-file-preview [data-state]');
  return state?.getAttribute('data-state') !== 'checking';
}

function nodeIsFocused(node) {
  return node === globalThis.document.activeElement;
}

function focusRingStyle(button) {
  const style = globalThis.getComputedStyle(button);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

function spinnerAnimationName(node) {
  return globalThis.getComputedStyle(node).animationName;
}

function allTabCountsAreUnknown(nodes) {
  for (const node of nodes) {
    if (!node.textContent?.trim().startsWith('–')) return false;
  }
  return true;
}

function frameName(index) {
  return `WRK-${80 + index}`;
}

const screenshotFileId = 'screen-1';
const screenshotName = 'screen.png';
const screenshotPath = `uploads/chat/${screenshotFileId}/${screenshotName}`;
const screenshotData = {
  conversationId: 'chat', fileId: screenshotFileId, uploadedBy: 'me', name: screenshotName,
  size: 421888, sha256: 'a'.repeat(64), mime: 'image/png',
  screenshot: { computerId: 'kijani-sales-01', generation: 4,
    capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900 },
};
const screenshotRejected = {
  conversationId: 'chat', fileId: screenshotFileId, uploadedBy: 'me', name: screenshotName,
  size: 421888, sha256: 'a'.repeat(64), reason: 'infected',
  screenshot: screenshotData.screenshot,
};
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">'
  + '<rect width="1440" height="900" fill="#172a2d"/>'
  + '<rect x="80" y="76" width="1280" height="64" rx="8" fill="#e4f6f9"/>'
  + '<rect x="80" y="176" width="800" height="560" rx="8" fill="#fbfcfc"/>'
  + '</svg>';

function makePreviewPng() {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.fillStyle = '#172a2d';
  context.fillRect(0, 0, 1, 1);
  return canvas.toDataURL('image/png').split(',')[1];
}

function addScreenshot(fixture, rejected = false) {
  const type = rejected ? 'file.rejected' : 'file.uploaded';
  const data = rejected ? screenshotRejected : screenshotData;
  return fixture.add(type, data);
}

async function openWorkspace(browser, width, options = {}) {
  const page = await browser.newPage({
    viewport: { width, height: 844 },
    reducedMotion: options.motion ?? 'no-preference',
  });
  const previewPng = await page.evaluate(makePreviewPng);
  await page.route(`${origin}/**`, serveAssets);
  const fixture = await chatFixture(page, 'empty-selected');
  const fileStatuses = new Map([[screenshotPath, options.fileStatus ?? 200]]);
  let denyMessages = false;
  async function serveFileView(route) {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
    const fileStatus = fileStatuses.get(path) ?? 200;
    if (fileStatus !== 200) {
      await route.fulfill({ status: fileStatus, contentType: 'application/json', body: '{}' });
      return;
    }
    if (url.searchParams.has('preview')) {
      await route.fulfill({ status: 200, contentType: 'image/png',
        body: Buffer.from(previewPng, 'base64') });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  }
  await page.route('**/files/view?*', serveFileView);
  async function serveMessages(route, request) {
    if (denyMessages && request.method() === 'GET') {
      await route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fallback();
  }
  await page.route('**/api/conversations/*/messages*', serveMessages);
  await page.goto(`${origin}/workspace?conversation=chat`);
  await page.locator('.transcript').waitFor();
  await page.waitForFunction(transcriptReady);
  if (width < 1100) {
    await page.getByRole('button', { name: 'Session panel' }).click();
    await page.getByRole('dialog', { name: 'Session', exact: true }).waitFor();
  }
  return {
    page,
    fixture,
    setFileStatus(status) { fileStatuses.set(screenshotPath, status); },
    denyNextFeedRead() { denyMessages = true; },
  };
}

async function capture(page, state, width, motion = 'no-preference') {
  await page.evaluate(waitForPageAnimations);
  const overflow = await page.evaluate(pageHasNoHorizontalOverflow);
  assert(overflow, `No horizontal overflow in ${state} at ${width}px`);
  const pageText = await page.locator('body').innerText();
  assert(!/Link expired|10 MB/u.test(pageText), 'No expired-link or size-limit wording');
  if (width <= 390) await checkScreenshotTargets(page, state);
  const filename = `${state}-${width}-${motion}.png`;
  await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
  captures.push(filename);
}

async function waitForPageAnimations() {
  const animations = globalThis.document.getAnimations();
  for (const animation of animations) {
    if (animation.effect?.getComputedTiming().iterations === Infinity) continue;
    try {
      await animation.finished;
    } catch {
      // An animation can be cancelled while the browser is settling the page.
    }
  }
}

async function checkScreenshotTargets(page, state) {
  const targets = page.locator([
    'oc-live-view .tools button', 'oc-live-view .capture-status button',
    '.entry-capture-status button', '.capture-line button', '.screenshot-card button',
    '.screenshot-card a', 'oc-file-preview a[overlayFooter]',
  ].join(', '));
  const count = await targets.count();
  for (let index = 0; index < count; index++) {
    const box = await targets.nth(index).boundingBox();
    if (!box) continue;
    assert(box.height >= 44 && box.width >= 44,
      `${state} action ${index} is ${box.width}×${box.height}px at phone width`);
  }
}

async function openViewer(page) {
  const computer = await computerFixture(page, { leaseUntilMs: 600000 });
  await page.getByRole('button', { name: 'Watch your computer', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Computer view', exact: true });
  await viewer.waitFor();
  await viewer.getByText('Connecting', { exact: true }).waitFor();
  computer.release();
  await computer.start();
  await viewer.getByText('Viewing', { exact: true }).waitFor();
  await viewer.getByRole('button', { name: 'Screenshot', exact: true }).waitFor();
  return { computer, viewer };
}

async function closePhoneSessionPanel(page) {
  const panel = page.getByRole('dialog', { name: 'Session', exact: true });
  if (await panel.count() === 0) return;
  if (!(await panel.isVisible())) return;
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
}

async function openPhoneSessionPanel(page) {
  const panel = page.getByRole('dialog', { name: 'Session', exact: true });
  if (await panel.isVisible()) return;
  await page.getByRole('button', { name: 'Session panel' }).click();
  await panel.waitFor();
}

async function installScreenshotRoute(page, fixture, firstMode) {
  let mode = firstMode;
  let fileId = screenshotFileId;
  let releaseHeld;
  let fileAppended = false;
  function holdScreenshotReply(resolve) {
    releaseHeld = resolve;
  }
  async function answerScreenshot(route) {
    const requestKey = route.request().headers()['idempotency-key'];
    keys.push(requestKey);
    if (mode === 'hold') {
      await new Promise(holdScreenshotReply);
      await route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ status: 'appended', fileId }) });
      addScreenshot(fixture);
      fileAppended = true;
      return;
    }
    if (mode === 'unknown') {
      if (!fileAppended) {
        addScreenshot(fixture);
        fileAppended = true;
      }
      await route.abort('connectionfailed');
      return;
    }
    if (mode === 'saved') {
      if (!fileAppended) {
        addScreenshot(fixture);
        fileAppended = true;
      }
      await route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ status: 'appended', fileId }) });
      return;
    }
    if (mode === 'rejected') {
      addScreenshot(fixture, true);
      await route.fulfill({ status: 422, contentType: 'application/json',
        body: JSON.stringify({ status: 'infected', fileId }) });
      return;
    }
    await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ status: 'unavailable' }) });
  }
  await page.route('**/api/conversations/*/screenshots', answerScreenshot);
  return {
    setMode(nextMode, nextFileId = screenshotFileId) {
      mode = nextMode;
      fileId = nextFileId;
    },
    release() { releaseHeld?.(); },
  };
}

async function saveScreenshot(page, fixture, mode) {
  const route = await installScreenshotRoute(page, fixture, mode);
  const { viewer } = await openViewer(page);
  await viewer.getByRole('button', { name: 'Screenshot', exact: true }).click();
  return { route, viewer };
}

async function saveScreenshotFrame(browser, width, state, mode) {
  const context = await openWorkspace(browser, width);
  const { route, viewer } = await saveScreenshot(context.page, context.fixture, mode);
  if (mode === 'hold') {
    await viewer.getByText('Capturing and saving screenshot…', { exact: true }).waitFor();
  } else if (mode === 'saved') {
    await viewer.getByText('Screenshot saved', { exact: true }).waitFor();
  } else if (mode === 'rejected') {
    await viewer.getByText('Screenshot rejected', { exact: true }).waitFor();
  } else {
    await viewer.getByText("Screenshot wasn't saved", { exact: true }).waitFor();
  }
  await capture(context.page, state, width);
  route.release();
  await context.page.close();
}

async function noScreenshot(browser, width) {
  const context = await openWorkspace(browser, width);
  await context.page.getByText('No screenshots yet', { exact: true }).waitFor();
  await capture(context.page, 'wrk-80-empty', width);
  await context.page.close();
}

async function savedScreenshot(browser, width, preview = false, thumbStatus = 200,
  previewStatus = 200) {
  const context = await openWorkspace(browser, width, { fileStatus: thumbStatus });
  addScreenshot(context.fixture);
  const card = context.page.locator('.screenshot-card');
  await card.waitFor();
  await context.page.getByText('Screenshot of kijani-sales-01.', { exact: false }).first().waitFor();
  if (preview) {
    await closePhoneSessionPanel(context.page);
    if (thumbStatus === 200) {
      context.setFileStatus(200);
    } else {
      await card.getByText("Preview couldn't load", { exact: true }).waitFor();
      context.setFileStatus(200);
      await card.getByRole('button', { name: 'Try preview again for screen.png' }).click();
      await card.locator('img').waitFor();
    }
    context.setFileStatus(previewStatus);
    await card.getByRole('button', { name: 'Open preview of screen.png' }).click();
    await context.page.getByRole('dialog', { name: 'screen.png', exact: true }).waitFor();
    if (previewStatus === 403) {
      await context.page.getByText('Preview unavailable. Your access is checked again',
        { exact: false }).waitFor();
    } else {
      await waitForPreviewReady(context.page);
    }
  }
  return { ...context, card };
}

async function waitForPreviewReady(page) {
  const preview = page.locator('oc-file-preview');
  await page.waitForFunction(previewFinishedLoading);
  const message = await preview.locator('.message').first().textContent();
  assert.equal(message?.trim(), 'Preview ready', `Preview response: ${await preview.innerText()}`);
}

async function checkPreviewFocus(page, card) {
  await closePhoneSessionPanel(page);
  const button = card.getByRole('button', { name: 'Open preview of screen.png' });
  await button.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: 'screen.png', exact: true });
  await preview.waitFor();
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'hidden' });
  assert.equal(await button.evaluate(nodeIsFocused), true,
    'Escape returns focus to the preview button');
}

async function focusByKeyboard(page, target) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.keyboard.press('Tab');
    const focused = await target.evaluate(nodeIsFocused);
    if (focused) return;
  }
  throw new Error('The Screenshot button was not reachable with Tab');
}

async function checkKeyboardAndRepeatedRetries(browser) {
  const context = await openWorkspace(browser, 390);
  const route = await installScreenshotRoute(context.page, context.fixture, 'failed');
  const { viewer } = await openViewer(context.page);
  const screenshot = viewer.getByRole('button', { name: 'Screenshot', exact: true });
  const previousRequestCount = keys.length;
  await focusByKeyboard(context.page, screenshot);
  const outline = await screenshot.evaluate(focusRingStyle);
  assert.deepEqual(outline, ['2px', 'rgb(10, 132, 151)', '2px']);
  await context.page.keyboard.press('Enter');
  await viewer.getByText("Screenshot wasn't saved", { exact: true }).waitFor();
  assert.equal(keys.length, previousRequestCount + 1, 'Enter starts one screenshot request');
  const originalKey = keys.at(-1);
  route.setMode('saved');
  await viewer.getByRole('button', { name: 'Try again', exact: true }).click();
  await viewer.getByText('Screenshot saved', { exact: true }).waitFor();
  assert.equal(keys.at(-1), originalKey, 'The 503 retry repeats the same key');
  const saved = await savedScreenshot(browser, 390);
  await checkPreviewFocus(saved.page, saved.card);
  await saved.page.close();
  await capture(context.page, 'wrk-85-failed-retry', 390);
  await context.page.close();
}

async function unknownAndRepeated(browser, width) {
  const context = await openWorkspace(browser, width);
  const route = await installScreenshotRoute(context.page, context.fixture, 'unknown');
  const { viewer } = await openViewer(context.page);
  await viewer.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await viewer.getByText('Screenshot outcome unknown', { exact: true }).waitFor();
  const originalKey = keys.at(-1);
  await viewer.getByRole('button', { name: 'Check status', exact: true }).click();
  await viewer.getByText('Files read again at', { exact: false }).waitFor();
  route.setMode('saved');
  await viewer.getByRole('button', { name: 'Send the same request again', exact: true }).click();
  await viewer.getByText('Screenshot already saved', { exact: true }).waitFor();
  assert.equal(keys.at(-1), originalKey, 'Unknown resend repeats the same key');
  assert.equal(await context.page.locator('.screenshot-card').count(), 1,
    'Repeated request keeps one transcript card');
  await context.page.keyboard.press('Escape');
  await closePhoneSessionPanel(context.page);
  await capture(context.page, 'wrk-91-repeated', width);
  await context.page.close();
}

async function rejectedAndNewKey(browser, width) {
  const context = await openWorkspace(browser, width);
  const route = await installScreenshotRoute(context.page, context.fixture, 'rejected');
  const { viewer } = await openViewer(context.page);
  await viewer.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await viewer.getByText('Screenshot rejected', { exact: true }).waitFor();
  const transcriptNotice = context.page.locator('.transcript')
    .getByText('Screenshot rejected', { exact: true });
  await transcriptNotice.waitFor();
  assert.equal(await transcriptNotice.count(), 1,
    'The transcript shows one durable rejection notice');
  assert.equal(await viewer.getByText('Screenshot rejected', { exact: true }).count(), 1,
    'The viewer shows one current rejection result');
  const firstKey = keys.at(-1);
  route.setMode('failed');
  await viewer.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await viewer.getByText("Screenshot wasn't saved", { exact: true }).waitFor();
  assert.notEqual(keys.at(-1), firstKey, 'A new capture after rejection has a new key');
  await context.page.keyboard.press('Escape');
  await closePhoneSessionPanel(context.page);
  await capture(context.page, 'wrk-87-rejected', width);
  await context.page.close();
}

async function deniedPreview(browser, width) {
  const context = await savedScreenshot(browser, width, true, 500, 403);
  context.denyNextFeedRead();
  const action = context.page.getByRole('button', { name: 'Check access and reopen', exact: true });
  await action.click();
  await context.page.locator('oc-file-preview').waitFor({ state: 'detached' });
  if (width < 1100) await openPhoneSessionPanel(context.page);
  await context.page.getByText('Files unavailable', { exact: true }).waitFor();
  await context.page.getByText("You don't have access to this conversation's files",
    { exact: true }).waitFor();
  assert.equal(await context.page.locator('.tab-count').evaluateAll(allTabCountsAreUnknown), true);
  assert.equal(await context.page.locator('img').count(), 0);
  assert.equal(await context.page.getByText('screen.png', { exact: true }).count(), 0);
  await capture(context.page, 'wrk-90-revoked', width);
  await context.page.close();
}

async function failedThumbnail(browser, width) {
  const context = await savedScreenshot(browser, width, false, 500);
  await context.card.getByText("Preview couldn't load", { exact: true }).waitFor();
  await context.card.getByRole('button', { name: 'Try preview again for screen.png' }).waitFor();
  await closePhoneSessionPanel(context.page);
  await capture(context.page, 'wrk-88-thumbnail-failed', width);
  await context.page.close();
}

async function disconnectedViewer(browser, width, unavailable = false) {
  const context = await openWorkspace(browser, width);
  if (unavailable) {
    async function refuseView(route) {
      await route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
    }
    await context.page.route('**/api/conversations/*/view', refuseView);
    await context.page.getByRole('button', { name: 'Watch your computer', exact: true }).click();
    const viewer = context.page.getByRole('dialog', { name: 'Computer view', exact: true });
    await viewer.getByText('Unavailable', { exact: true }).waitFor();
    assert((await viewer.innerText()).includes(
      'Screenshots are not available until you can watch this computer.',
    ));
  } else {
    const { computer, viewer } = await openViewer(context.page);
    computer.disconnect();
    await viewer.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
    assert((await viewer.innerText()).includes('Reconnect to take a screenshot.'));
  }
  await capture(context.page, unavailable ? 'wrk-86-unavailable' : 'wrk-86-disconnected', width);
  await context.page.close();
}

async function reducedMotionCaptures(browser) {
  const saving = await openWorkspace(browser, 390, { motion: 'reduce' });
  const { route, viewer } = await saveScreenshot(saving.page, saving.fixture, 'hold');
  await viewer.getByText('Capturing and saving screenshot…', { exact: true }).waitFor();
  const spinner = viewer.locator('.spinner').first();
  const animation = await spinner.evaluate(spinnerAnimationName);
  assert.equal(animation, 'none');
  await capture(saving.page, 'saving', 390, 'reduce');
  route.release();
  await saving.page.close();

  const saved = await openWorkspace(browser, 390, { motion: 'reduce' });
  const routeForSave = await installScreenshotRoute(saved.page, saved.fixture, 'saved');
  const opened = await openViewer(saved.page);
  await opened.viewer.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await opened.viewer.getByText('Screenshot saved', { exact: true }).waitFor();
  assert.equal(await opened.viewer.locator('.spinner').count(), 0,
    'A saved result does not show a progress spinner');
  await capture(saved.page, 'saved', 390, 'reduce');
  routeForSave.setMode('failed');
  await saved.page.close();
}

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of widths) {
      await noScreenshot(browser, width);
      await saveScreenshotFrame(browser, width, 'wrk-81-saving', 'hold');
      await saveScreenshotFrame(browser, width, 'wrk-82-saving', 'hold');
      await saveScreenshotFrame(browser, width, 'wrk-83-saved', 'saved');

      const preview = await savedScreenshot(browser, width, true);
      await capture(preview.page, 'wrk-84-preview', width);
      await checkPreviewFocus(preview.page, preview.card);
      await preview.page.close();

      await saveScreenshotFrame(browser, width, 'wrk-85-failed', 'failed');
      await disconnectedViewer(browser, width);
      await rejectedAndNewKey(browser, width);
      await failedThumbnail(browser, width);

      const refusedPreview = await savedScreenshot(browser, width, true, 500, 403);
      await capture(refusedPreview.page, 'wrk-89-preview-access-check', width);
      await refusedPreview.page.close();

      await deniedPreview(browser, width);
      await unknownAndRepeated(browser, width);
    }
    await disconnectedViewer(browser, 390, true);
    await checkKeyboardAndRepeatedRetries(browser);
    await reducedMotionCaptures(browser);
  } finally {
    await browser.close();
  }
  const visual = {
    result: 'PASS',
    widths,
    motion: ['no-preference', 'reduce'],
    captures: captures.length,
    files: captures,
    environment: 'Built Angular assets; Chromium; intercepted protocol fixtures; no stack',
    frames: Array.from({ length: 12 }, frameName),
    checks: [
      'No horizontal overflow at 1280px, 390px and 320px',
      'Capture, card, preview and retry actions meet phone target sizes',
      'Screenshot starts by keyboard and shows the 2px focus ring',
      'Escape returns focus from preview to its opening card button',
      '503 retry and unknown resend reuse their keys; a new capture changes its key',
      'A repeated capture returns one card and says the screenshot was already saved',
      'A scan rejection appears once in the transcript and allows a new key',
      'A denial hides names, images and numeric tab counts',
      'No Link expired or 10 MB copy appears',
      'Reduced-motion saving and saved frames use a static spinner',
    ],
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(visual, null, 2)}\n`);
  console.log(`P3-18 screenshots: PASS (${captures.length} captures)`);
}

await main();
