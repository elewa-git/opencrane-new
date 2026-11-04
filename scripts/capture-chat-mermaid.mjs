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
  const question = fixture.add('message.posted',
    { text: 'Please show the diagram.', authorId: 'me' });
  fixture.add('agent.turn_started', { turnId: question.id });
  fixture.add('agent.message_delta', { turnId: question.id, messageId: 'reply', text });
  await page.goto('https://mermaid.opencrane.test/workspace?conversation=chat');
  const reply = page.locator('oc-assistant-markdown');
  await reply.getByRole('heading', { name: 'A simple route' }).waitFor();
  await page.evaluate(waitForFonts);
  return { fixture, question, reply };
}

async function captureRendered(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 1100 },
    reducedMotion: 'reduce' });
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
    fixture.add('agent.message_delta',
      { turnId: question.id, messageId: 'reply', text: diagram });
    const image = reply.getByRole('img', { name: 'Diagram' });
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
    await page.screenshot({ path: resolve(output, `diagram-${width}.png`), fullPage: true });
  } finally {
    await page.close();
  }
}

async function captureFailure(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 1100 },
    reducedMotion: 'reduce' });
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
    await reply.locator('pre code').filter({ hasText: code }).waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await reply.locator('pre code').textContent(), code);
    assert.equal(await reply.locator('img, iframe, svg, script').count(), 0);
    assert(consoleMessages.every(hidesReply));
    assert(await page.evaluate(pageHasNoOverflow));
    await page.screenshot({ path: resolve(output, `source-${width}.png`), fullPage: true });
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    await captureRendered(browser, width);
    await captureFailure(browser, width);
  }
} finally {
  await browser.close();
}
console.log('PASS: intercepted Mermaid replies at 1280 and 390 px.');
