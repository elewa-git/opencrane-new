import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/reply-images');
const build = resolve('apps/web/dist/web/browser');

async function rasterImage(browser) {
  const page = await browser.newPage();
  try {
    const drawing = '<div style="width:320px;height:180px;background:#e9f6f7;'
      + 'font:24px sans-serif;color:#177b8b;display:grid;place-items:center">'
      + 'Shared drawing</div>';
    await page.setContent(drawing);
    return await page.locator('div').screenshot();
  } finally {
    await page.close();
  }
}

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function addReply(fixture, imageSize) {
  const question = fixture.add('message.posted',
    { text: 'Show the architecture.', authorId: 'me' });
  fixture.add('agent.turn_started', { turnId: question.id });
  fixture.add('file.uploaded', { conversationId: 'chat', fileId: 'drawing',
    uploadedBy: 'me', turnId: question.id, name: 'architecture.png',
    size: imageSize, mime: 'image/png' });
  fixture.add('agent.file_changed', { turnId: question.id,
    path: 'uploads/chat/drawing/architecture.png', changeType: 'created' });
  const text = 'Here is the architecture.\n\n'
    + '![Architecture diagram](/workspace/artifacts/architecture.png)\n\n'
    + 'Draft: [draft.svg](/workspace/notes/draft.svg)';
  fixture.add('agent.message_delta', { turnId: question.id, messageId: 'reply', text });
  fixture.add('agent.turn_completed', { turnId: question.id });
}

async function serveImage(route, image) {
  const url = new URL(route.request().url());
  assert.equal(url.searchParams.get('path'), 'uploads/chat/drawing/architecture.png');
  assert.equal(url.searchParams.get('preview'), 'true');
  await route.fulfill({ status: 200, contentType: 'image/png', body: image,
    headers: { 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox" } });
}

function scrollToStart(element) {
  element.scrollTop = 0;
}

async function capture(browser, width, image) {
  const page = await browser.newPage({ viewport: { width, height: 1100 },
    reducedMotion: 'reduce' });
  try {
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'empty-selected');
    addReply(fixture, image.length);
    async function servePublishedImage(route) {
      await serveImage(route, image);
    }
    await page.route(/\/api\/conversations\/chat\/files\/view/, servePublishedImage);
    await page.goto('https://images.opencrane.test/workspace?conversation=chat');
    const reply = page.locator('oc-assistant-markdown');
    const inlineImage = reply.getByRole('img', { name: 'Architecture diagram' });
    await inlineImage.waitFor();
    await page.evaluate(waitForFonts);
    assert.equal(await inlineImage.getAttribute('src'),
      '/api/conversations/chat/files/view?path=uploads%2Fchat%2Fdrawing%2Farchitecture.png'
        + '&preview=true');
    assert.equal(await reply.getByText('draft.svg — not shared by the agent.').count(), 1);
    assert.equal(await reply.locator('img').count(), 1);
    assert.equal(await reply.locator('a').count(), 0);
    assert(await page.evaluate(pageHasNoOverflow));
    await page.locator('.transcript').evaluate(scrollToStart);
    await page.screenshot({ path: resolve(output, `reply-${width}.png`), fullPage: true });
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const image = await rasterImage(browser);
  for (const width of [1280, 390]) {
    await capture(browser, width, image);
  }
} finally {
  await browser.close();
}
console.log('PASS: intercepted shared image replies at 1280 and 390 px.');
