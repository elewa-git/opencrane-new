import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/chat-markdown-1');
const build = resolve('apps/web/dist/web/browser');
const reply = '# A clear plan\n\nUse **small steps** and *check each result*. '
  + 'Read the [guide](https://example.test/guide) or use `status`. Source [1]\n\n'
  + '- Review the request\n- Prepare the reply\n\n1. Check the details\n2. Share the result\n\n'
  + '> Keep the next step clear.\n\n```ts\nconst ready = true;\n```\n\n'
  + '```mermaid\ngraph LR\n  Request --> Reply\n```\n\n'
  + '<img src=x onerror=alert(1)> [Unsafe link](javascript:alert)';

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function transcriptHasNoOverflow(element) {
  return element.scrollWidth <= element.clientWidth;
}

async function capture(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 1100 },
    reducedMotion: 'reduce' });
  try {
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'empty-selected');
    const question = fixture.add('message.posted',
      { text: 'Please show the plan with examples.', authorId: 'me' });
    fixture.add('agent.turn_started', { turnId: question.id });
    fixture.add('agent.message_delta', { turnId: question.id, messageId: 'reply', text: reply });
    fixture.add('agent.turn_completed', { turnId: question.id });
    await page.goto('https://markdown.opencrane.test/workspace?conversation=chat');
    const markdown = page.locator('oc-assistant-markdown');
    await markdown.getByRole('heading', { name: 'A clear plan' }).waitFor();
    await page.evaluate(waitForFonts);
    assert.equal(await markdown.locator('pre').count(), 2);
    assert.equal(await markdown.locator('img, script, iframe, svg').count(), 0);
    assert.equal(await markdown.locator('a').count(), 1);
    assert(await page.evaluate(pageHasNoOverflow));
    assert(await page.locator('.transcript').evaluate(transcriptHasNoOverflow));
    await markdown.scrollIntoViewIfNeeded();
    await page.locator('.transcript').evaluate(scrollToStart);
    await page.screenshot({ path: resolve(output, `reply-${width}.png`), fullPage: true });
    await page.evaluate(installClipboard, true);
    await markdown.getByRole('button', { name: 'Copy code' }).first().click();
    await markdown.getByRole('status').filter({ hasText: 'Copied' }).waitFor();
    await page.screenshot({ path: resolve(output, `copied-${width}.png`), fullPage: true });
    await page.evaluate(installClipboard, false);
    await markdown.getByRole('button', { name: 'Copy code' }).last().click();
    await markdown.getByText('Could not copy. Try again.').waitFor();
    await page.screenshot({ path: resolve(output, `copy-refused-${width}.png`), fullPage: true });
  } finally {
    await page.close();
  }
}

function installClipboard(allowed) {
  function writeText() {
    if (allowed) return Promise.resolve();
    return Promise.reject(new Error('Refused'));
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

function scrollToStart(element) {
  element.scrollTop = 0;
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) await capture(browser, width);
} finally {
  await browser.close();
}
console.log('PASS: intercepted Markdown replies at 1280 and 390 px.');
