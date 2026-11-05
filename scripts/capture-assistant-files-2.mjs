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
    await page.setContent('<div style="width:320px;height:180px;background:#e9f6f7;'
      + 'font:24px sans-serif;color:#177b8b;display:grid;place-items:center">'
      + 'Project sketch</div>');
    return await page.locator('div').screenshot();
  } finally {
    await page.close();
  }
}

async function capture(browser, width, png) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 1400 : 1100 },
    reducedMotion: 'reduce' });
  try {
    let scriptRan = false;
    function refuseScript(dialog) {
      scriptRan = true;
      void dialog.dismiss();
    }
    page.on('dialog', refuseScript);
    async function serveAssets(route) {
      await serveWebBuild(route, build);
    }
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'empty-selected');
    const question = fixture.add('message.posted',
      { text: 'Show the finished images.', authorId: 'me' });
    fixture.add('agent.turn_started', { turnId: question.id });
    fixture.add('file.uploaded', { conversationId: 'chat', fileId: 'upload',
      uploadedBy: 'me', name: 'reference.png', size: png.length, mime: 'image/png' });
    fixture.add('file.uploaded', { conversationId: 'chat', fileId: 'drawing',
      uploadedBy: 'me', turnId: question.id, name: 'drawing.svg',
      size: Buffer.byteLength(svg), mime: 'image/svg+xml' });
    fixture.add('agent.file_changed', { turnId: question.id,
      path: 'uploads/chat/drawing/drawing.svg', changeType: 'created' });
    fixture.add('agent.message_delta', { turnId: question.id, messageId: 'reply',
      text: 'The [drawing](/workspace/artifacts/drawing.svg) is ready. '
        + '[Private file](/workspace/artifacts/private.svg) cannot be opened here.' });
    fixture.add('agent.turn_completed', { turnId: question.id });
    async function serveFile(route) {
      const url = new URL(route.request().url());
      const path = url.searchParams.get('path') ?? '';
      const isSvg = path.endsWith('drawing.svg');
      await route.fulfill({ status: 200,
        contentType: isSvg ? 'image/svg+xml' : 'image/png',
        headers: { 'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff' },
        body: isSvg ? svg : png });
    }
    await page.route(/\/api\/conversations\/chat\/files\/view/, serveFile);
    await page.goto('https://files.opencrane.test/workspace?conversation=chat');
    await page.getByRole('button', { name: 'Open preview of drawing.svg' }).waitFor();
    await page.evaluate(waitForFonts);
    assert.equal(await page.locator('oc-assistant-markdown svg, oc-assistant-markdown script')
      .count(), 0);
    assert.equal(await page.getByText('File not available').count(), 1);
    assert.equal(await page.locator('oc-conversation-file-card button img').count(), 2);
    await page.locator('.transcript').evaluate(scrollToStart);
    await page.screenshot({ path: resolve(output, `images-${width}.png`), fullPage: true });
    const thumbnail = page.locator('oc-conversation-file-card button:has(img)').first();
    await thumbnail.press('Space');
    await page.locator('oc-file-preview img').waitFor();
    await page.getByRole('button', { name: 'Close preview' }).click();
    await thumbnail.press('Enter');
    await page.locator('oc-file-preview img').waitFor();
    await page.getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('button', { name: 'drawing', exact: true }).press('Enter');
    await page.locator('oc-file-preview img').waitFor();
    assert.equal(await page.locator('oc-file-preview script, '
      + 'oc-file-preview section[aria-label="Preview content"] svg').count(), 0);
    assert.equal(scriptRan, false);
    await page.screenshot({ path: resolve(output, `preview-${width}.png`), fullPage: true });
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const png = await rasterImage(browser);
  for (const width of [1280, 390]) {
    await capture(browser, width, png);
  }
} finally {
  await browser.close();
}
console.log('PASS: intercepted assistant images and file links at 1280 and 390 px.');
