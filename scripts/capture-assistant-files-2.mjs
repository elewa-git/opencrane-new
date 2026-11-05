import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/assistant-files-2');
const build = resolve('apps/web/dist/web/browser');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" '
  + 'viewBox="0 0 320 180"><rect width="320" height="180" fill="#e9f6f7"/>'
  + '<path d="M30 130L100 90L170 108L240 40L290 58" fill="none" stroke="#177b8b" '
  + 'stroke-width="8"/><script>alert(1)</script></svg>';

function scrollToStart(element) {
  element.scrollTop = 0;
}

async function rasterImage(browser) {
  const page = await browser.newPage();
  try {
    const imageContent = '<div style="width:320px;height:180px;background:#e9f6f7;'
      + 'font:24px sans-serif;color:#177b8b;display:grid;place-items:center">'
      + 'Project sketch</div>';
    await page.setContent(imageContent);
    return await page.locator('div').screenshot();
  } finally {
    await page.close();
  }
}

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function addChatEvents(fixture, png) {
  const questionData = { text: 'Show the finished images.', authorId: 'me' };
  const question = fixture.add('message.posted', questionData);
  const turnStarted = { turnId: question.id };
  fixture.add('agent.turn_started', turnStarted);
  const uploadData = { conversationId: 'chat', fileId: 'upload',
    uploadedBy: 'me', name: 'reference.png', size: png.length, mime: 'image/png' };
  fixture.add('file.uploaded', uploadData);
  const drawingData = { conversationId: 'chat', fileId: 'drawing',
    uploadedBy: 'me', turnId: question.id, name: 'drawing.svg',
    size: Buffer.byteLength(svg), mime: 'image/svg+xml' };
  fixture.add('file.uploaded', drawingData);
  const changeData = { turnId: question.id,
    path: 'uploads/chat/drawing/drawing.svg', changeType: 'created' };
  fixture.add('agent.file_changed', changeData);
  const replyData = { turnId: question.id, messageId: 'reply',
    text: 'The [drawing](/workspace/artifacts/drawing.svg) is ready. '
      + '[Private file](/workspace/artifacts/private.svg) cannot be opened here.' };
  fixture.add('agent.message_delta', replyData);
  const completedData = { turnId: question.id };
  fixture.add('agent.turn_completed', completedData);
}

async function installFileRoute(page, png) {
  async function serveFile(route) {
    const url = new URL(route.request().url());
    const path = url.searchParams.get('path') ?? '';
    const isSvg = path.endsWith('drawing.svg');
    const headers = { 'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff' };
    const response = { status: 200,
      contentType: isSvg ? 'image/svg+xml' : 'image/png',
      headers, body: isSvg ? svg : png };
    await route.fulfill(response);
  }
  await page.route(/\/api\/conversations\/chat\/files\/view/, serveFile);
}

async function captureImageCards(page, width) {
  const drawingPreviewOptions = { name: 'Open preview of drawing.svg' };
  await page.getByRole('button', drawingPreviewOptions).waitFor();
  await page.evaluate(waitForFonts);
  const injectedMarkup = page.locator('oc-assistant-markdown svg, oc-assistant-markdown script');
  assert.equal(await injectedMarkup.count(), 0);
  assert.equal(await page.getByText('File not available').count(), 1);
  assert.equal(await page.locator('oc-conversation-file-card button img').count(), 2);
  await page.locator('.transcript').evaluate(scrollToStart);
  const screenshotOptions = { path: resolve(output, `images-${width}.png`), fullPage: true };
  await page.screenshot(screenshotOptions);
}

async function openPreviewWithKeyboard(page) {
  const thumbnail = page.locator('oc-conversation-file-card button:has(img)').first();
  const closeOptions = { name: 'Close preview' };
  const closeButton = page.getByRole('button', closeOptions);
  const previewImage = page.locator('oc-file-preview img');
  await thumbnail.press('Space');
  await previewImage.waitFor();
  await closeButton.click();
  await thumbnail.press('Enter');
  await previewImage.waitFor();
  await closeButton.click();
  const drawingOptions = { name: 'drawing', exact: true };
  const drawingButton = page.getByRole('button', drawingOptions);
  await drawingButton.press('Enter');
  await previewImage.waitFor();
}

async function capturePreview(page, width, scriptState) {
  await openPreviewWithKeyboard(page);
  const injectedMarkup = page.locator('oc-file-preview script, '
    + 'oc-file-preview section[aria-label="Preview content"] svg');
  assert.equal(await injectedMarkup.count(), 0);
  assert.equal(scriptState.ran, false);
  const screenshotOptions = { path: resolve(output, `preview-${width}.png`), fullPage: true };
  await page.screenshot(screenshotOptions);
}

async function capture(browser, width, png) {
  const viewport = { width, height: width === 390 ? 1400 : 1100 };
  const pageOptions = { viewport, reducedMotion: 'reduce' };
  const page = await browser.newPage(pageOptions);
  try {
    const scriptState = { ran: false };
    function refuseScript(dialog) {
      scriptState.ran = true;
      void dialog.dismiss();
    }
    page.on('dialog', refuseScript);
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'empty-selected');
    addChatEvents(fixture, png);
    await installFileRoute(page, png);
    await page.goto('https://files.opencrane.test/workspace?conversation=chat');
    await captureImageCards(page, width);
    await capturePreview(page, width, scriptState);
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const launchOptions = { headless: true };
const browser = await chromium.launch(launchOptions);
try {
  const png = await rasterImage(browser);
  for (const width of [1280, 390]) {
    await capture(browser, width, png);
  }
} finally {
  await browser.close();
}
console.log('PASS: intercepted assistant images and file links at 1280 and 390 px.');
