import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/chat-mermaid');
const build = resolve('apps/web/dist/web/browser');

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function scriptCount() {
  const resources = performance.getEntriesByType('resource');
  let count = 0;
  for (const resource of resources) {
    if (resource.name.includes('.js')) {
      count += 1;
    }
  }
  return count;
}

function transcriptHasNoOverflow(element) {
  return element.scrollWidth <= element.clientWidth;
}

async function openReply(page, text) {
  await page.route('**/*', serveAssets);
  const fixture = await chatFixture(page, 'empty-selected');
  const questionPayload = { text: 'Please show the diagram.', authorId: 'me' };
  const question = fixture.add('message.posted', questionPayload);
  const turn = { turnId: question.id };
  const delta = { ...turn, messageId: 'reply', text };
  fixture.add('agent.turn_started', turn);
  fixture.add('agent.message_delta', delta);
  await page.goto('https://mermaid.opencrane.test/workspace?conversation=chat');
  const reply = page.locator('oc-assistant-markdown');
  const headingOptions = { name: 'A simple route' };
  const heading = reply.getByRole('heading', headingOptions);
  await heading.waitFor();
  await page.evaluate(waitForFonts);
  return { fixture, question, reply };
}

async function captureRendered(browser, width) {
  const pageOptions = { viewport: { width, height: 1100 }, reducedMotion: 'reduce' };
  const page = await browser.newPage(pageOptions);
  try {
    const { fixture, question, reply } = await openReply(page,
      '# A simple route\n\nThe steps appear below.');
    await page.waitForLoadState('networkidle');
    const beforeDiagram = await page.evaluate(scriptCount);
    assert.equal(await reply.locator('img').count(), 0);

    const diagram = '\n\n```mermaid\n'
      + '%%{init: {"securityLevel": "loose", "htmlLabels": true, "logLevel": "debug"}}%%\n'
      + 'graph LR\n  Start --> Check --> Done\n'
      + '  click Start "javascript:alert(1)"\n```';
    const delta = { turnId: question.id, messageId: 'reply', text: diagram };
    fixture.add('agent.message_delta', delta);
    const imageOptions = { name: 'Diagram' };
    const image = reply.getByRole('img', imageOptions);
    await image.waitFor();
    const source = await image.getAttribute('src');
    assert.match(source, /^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(source.split(',')[1], 'base64').toString('utf8');
    assert.doesNotMatch(svg, /javascript:|<script|<foreignObject/i);
    assert.equal(await reply.locator('a, iframe, svg, script').count(), 0);
    assert((await page.evaluate(scriptCount)) > beforeDiagram);
    assert(await page.evaluate(pageHasNoOverflow));
    assert(await page.locator('.transcript').evaluate(transcriptHasNoOverflow));
    await reply.scrollIntoViewIfNeeded();
    const screenshotOptions = { path: resolve(output, `diagram-${width}.png`), fullPage: true };
    await page.screenshot(screenshotOptions);
  } finally {
    await page.close();
  }
}

async function captureFailure(browser, width) {
  const pageOptions = { viewport: { width, height: 1100 }, reducedMotion: 'reduce' };
  const page = await browser.newPage(pageOptions);
  try {
    const code = 'this is not a diagram';
    const consoleMessages = [];
    function captureConsole(message) {
      consoleMessages.push(message.text());
    }
    function hidesReply(message) {
      return !message.includes(code);
    }
    page.on('console', captureConsole);
    const text = '# A simple route\n\n```mermaid\n' + code + '\n```';
    const { reply } = await openReply(page, text);
    const sourceOptions = { hasText: code };
    const source = reply.locator('pre code');
    const matchingSource = source.filter(sourceOptions);
    await matchingSource.waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await reply.locator('pre code').textContent(), code);
    assert.equal(await reply.locator('img, iframe, svg, script').count(), 0);
    assert(consoleMessages.every(hidesReply));
    assert(await page.evaluate(pageHasNoOverflow));
    const screenshotOptions = { path: resolve(output, `source-${width}.png`), fullPage: true };
    await page.screenshot(screenshotOptions);
  } finally {
    await page.close();
  }
}

const directoryOptions = { recursive: true };
await mkdir(output, directoryOptions);
const browserOptions = { headless: true };
const browser = await chromium.launch(browserOptions);
try {
  for (const width of [1280, 390]) {
    await captureRendered(browser, width);
    await captureFailure(browser, width);
  }
} finally {
  await browser.close();
}
console.log('PASS: intercepted Mermaid replies at 1280 and 390 px.');
