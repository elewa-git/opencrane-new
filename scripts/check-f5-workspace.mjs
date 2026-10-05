import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

const output = resolve('docs/process/f5-workspace');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://f5.opencrane.test';
const captures = [];
const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

async function serveAssets(route) {
  const url = new URL(route.request().url());
  let filename = resolve(build, `.${url.pathname}`);
  if (!extname(url.pathname)) {
    filename = resolve(build, 'index.html');
  }
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  const body = await readFile(filename);
  const contentType = contentTypes[extname(filename)] ?? 'application/octet-stream';
  await route.fulfill({ body, contentType });
}

async function serveScreenshotThumbnail(route) {
  const url = new URL(route.request().url());
  const path = url.searchParams.get('path');
  if (path === 'uploads/chat/screen/quarterly-screen-capture.png') {
    const screenshot = '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">'
      + '<rect width="1440" height="900" fill="#172a2d"/>'
      + '<rect x="80" y="76" width="1280" height="64" rx="8" fill="#e4f6f9"/>'
      + '<rect x="80" y="176" width="800" height="560" rx="8" fill="#fbfcfc"/>'
      + '<rect x="920" y="176" width="440" height="260" rx="8" fill="#9fdde8"/>'
      + '</svg>';
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: screenshot });
    return;
  }
  await route.fulfill({ status: 404 });
}

function pageHasNoOverflow() {
  const documentWidth = globalThis.document.documentElement.scrollWidth;
  const viewportWidth = globalThis.window.innerWidth;
  return documentWidth <= viewportWidth;
}

function focused(node) {
  return node === globalThis.document.activeElement;
}

function outline(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

async function waitForFonts() {
  await globalThis.document.fonts.ready;
}

function panelAnimation(node) {
  const style = globalThis.getComputedStyle(node);
  return style.animationName;
}

async function scrollTranscriptToLatest(page) {
  const transcript = page.locator('.transcript');
  await transcript.evaluate(scrollElementToLatest);
  await page.evaluate(waitForAnimationFrame);
}

function scrollElementToLatest(element) {
  element.scrollTop = element.scrollHeight;
}

function waitForAnimationFrame() {
  function finishAtNextFrame(resolve) {
    globalThis.requestAnimationFrame(resolve);
  }
  return new Promise(finishAtNextFrame);
}

async function capture(page, name, width, motion) {
  assert(await page.locator('html').evaluate(pageHasNoOverflow), 'No horizontal overflow');
  const filename = `${name}-${width}-${motion}.png`;
  await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
  captures.push(filename);
}

async function checkToolAndBudget(page) {
  const toolLine = page.locator('oc-tool-activity-line').first();
  await toolLine.waitFor();
  const summary = toolLine.locator('summary');
  assert.equal((await summary.textContent())?.trim(), 'Command failed');
  await summary.focus();
  assert.deepEqual(await summary.evaluate(outline),
    ['2px', 'rgb(10, 132, 151)', '2px']);
  await page.keyboard.press('Enter');
  const details = toolLine.locator('.tool-drawer');
  await details.waitFor();
  assert.equal(await toolLine.getByRole('button', { name: /retry/i }).count(), 0,
    'Tool details do not suggest a fresh message retry');
  assert((await details.innerText()).includes('Failed · Exit code 1'));
  assert.equal(await toolLine.locator('[data-state="failed"]').count(), 1);
  await page.getByText('Reply failed', { exact: true }).waitFor();

  const budgetNotice = page.locator('oc-budget-stop-notice');
  await budgetNotice.waitFor();
  const budgetCopy = await budgetNotice.textContent();
  assert(budgetCopy?.includes('An Owner or Admin can review the limit'));
  assert(budgetCopy?.includes('next monthly budget period (UTC)'));
  assert.equal(await budgetNotice.getByRole('alert').count(), 0);
  const budgetState = budgetNotice.locator('oc-shared-state .state');
  assert.equal(await budgetState.getAttribute('data-state'), 'blocked');
}

async function checkFileCard(page, width) {
  const assistantCard = page.locator('oc-conversation-file-card:has(.file-card.created)');
  await assistantCard.waitFor();
  assert((await assistantCard.innerText()).includes('quarterly-board-pack.xlsx'));
  assert.equal(await assistantCard.getByRole('link', { name: /Download/ }).count(), 0);
  const screenshotCard = page.locator('oc-conversation-file-card').filter({
    hasText: 'quarterly-screen-capture.png',
  });
  const download = screenshotCard.getByRole('link', {
    name: 'Download quarterly-screen-capture.png',
  });
  const screenshotThumbnail = screenshotCard.locator('.screenshot-thumbnail');
  assert(await screenshotThumbnail.evaluate(imageHasLoaded), 'Screenshot thumbnail has an image');
  const filesButton = assistantCard.getByRole('button', { name: 'Open session files' });
  const href = await download.getAttribute('href');
  assert(href?.includes('uploads%2Fchat%2Fscreen%2Fquarterly-screen-capture.png'));
  if (width === 390) {
    const open = assistantCard.getByRole('button', {
      name: 'Open quarterly-board-pack.xlsx',
    });
    assert((await open.boundingBox()).height >= 44);
    assert((await filesButton.boundingBox()).height >= 44);
    assert((await assistantCard.locator('.file-name').boundingBox()).width > 80);
    const screenshotOpen = screenshotCard.getByRole('button', {
      name: 'Open quarterly-screen-capture.png',
    });
    assert((await screenshotOpen.boundingBox()).height >= 44);
    assert((await download.boundingBox()).height >= 44);
    assert((await screenshotCard.locator('.file-name').boundingBox()).width > 80);
  }
  if (width === 320) {
    assert((await assistantCard.locator('.file-name').boundingBox()).width > 80);
    assert((await screenshotCard.locator('.file-name').boundingBox()).width > 80);
  }
}

async function imageHasLoaded(image) {
  await image.decode();
  return image.naturalWidth > 0;
}

async function checkReadFailures(browser) {
  for (const status of [500, 503, 403]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route(`${origin}/**`, serveAssets);
    await chatFixture(page, `read-${status}`);
    await page.goto(`${origin}/workspace?conversation=chat`);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByText('No messages yet', { exact: true }).count(), 0);
    assert.equal(await page.getByText('No screenshots yet', { exact: true }).count(), 0);
    await page.close();
  }
}

async function checkStreamingLayout(browser, width, motion) {
  const page = await browser.newPage({
    viewport: { width, height: 844 },
    reducedMotion: motion,
  });
  await page.route(`${origin}/**`, serveAssets);
  await chatFixture(page, 'streaming');
  await page.goto(`${origin}/workspace?conversation=chat`);
  const stopButton = page.locator('oc-chat-composer')
    .getByRole('button', { name: 'Stop', exact: true });
  await stopButton.waitFor();
  assert.equal(await stopButton.evaluate(button => button.scrollWidth <= button.clientWidth), true);
  await capture(page, 'streaming', width, motion);
  await page.close();
}

async function checkPhonePanel(page, motion) {
  const opener = page.getByRole('button', { name: 'Session panel' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Session', exact: true });
  await panel.waitFor();
  assert.equal(await panel.locator('.panel-header').count(), 0);
  assert.equal(await panel.locator(':scope > .body > :first-child').getAttribute('class'),
    'panel-tabs');
  assert(await panel.getByRole('tab', { name: /Files/ }).isVisible());
  assert(await panel.getByRole('tab', { name: /Activity/ }).isVisible());
  assert(await panel.getByText('No screenshots yet', { exact: true }).isVisible());
  const panelCopy = await panel.textContent();
  assert(!panelCopy?.includes('Decisions'));
  assert(!panelCopy?.includes('People'));
  const expectedAnimation = motion === 'reduce' ? 'none' : 'oc-hinge';
  assert.equal(await panel.evaluate(panelAnimation), expectedAnimation);
  await capture(page, 'phone-panel', 390, motion);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert(await opener.evaluate(focused), 'Escape returns focus to the panel opener');
}

const browser = await chromium.launch();
try {
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390, 320]) {
    for (const motion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: motion });
      await page.route(`${origin}/**`, serveAssets);
      await chatFixture(page, 'empty-selected');
      await page.goto(`${origin}/workspace?conversation=chat`);
      await page.locator('oc-chat-composer').waitFor();
      await page.evaluate(waitForFonts);
      if (width === 390) {
        assert(await page.getByText('No messages yet', { exact: true }).isVisible());
      }
      await capture(page, 'empty-workspace', width, motion);
      if (width === 390) {
        await checkPhonePanel(page, motion);
      }
      await page.close();

      const evidencePage = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: motion,
      });
      await evidencePage.route(`${origin}/**`, serveAssets);
      await chatFixture(evidencePage, 'workspace-evidence');
      await evidencePage.route('**/files/view?*', serveScreenshotThumbnail);
      await evidencePage.goto(`${origin}/workspace?conversation=chat`);
      await evidencePage.locator('oc-tool-activity-line').first().waitFor();
      await checkToolAndBudget(evidencePage);
      await checkFileCard(evidencePage, width);
      await evidencePage.evaluate(waitForFonts);
      await scrollTranscriptToLatest(evidencePage);
      await capture(evidencePage, 'workspace-effects', width, motion);
      await evidencePage.close();

      if (width < 700) {
        await checkStreamingLayout(browser, width, motion);
      }
    }
  }
  await checkReadFailures(browser);

  const result = {
    result: 'PASS',
    widths: [1280, 390, 320],
    motion: ['no-preference', 'reduce'],
    captures: captures.length,
    files: captures,
    environment: 'Built Angular assets; Chromium; intercepted protocol fixtures; no stack',
    frames: [
      'WRK-01-1280', 'WRK-01-390', 'WRK-01-320',
      'WRK-03-1280', 'WRK-03-390', 'WRK-04-1280', 'WRK-04-390',
      'WRK-83-1280', 'WRK-83-390', 'WRK-83-320',
      'WRK-40-1280', 'WRK-40-390', 'WRK-41-1280', 'WRK-41-390',
      'WRK-42-1280', 'WRK-42-390', 'SPD-54-1280', 'SPD-54-390',
    ],
    checks: [
      'Sanitised tool line opens by keyboard and keeps a 2px focus ring',
      'Failed commands and turns show failure without offering a retry',
      'Budget stop tells the reader who can help and when it resets',
      'Only readable uploads and screenshots offer Download',
      'Failed and refused reads never look like empty conversations',
      'Phone panel keeps Files and Activity tabs and closes with Escape',
      '44px phone file actions',
      'No horizontal overflow',
      'Reduced-motion panel entrance is immediate',
    ],
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS F5 workspace: ${captures.length} captures; 1280/390/320 and reduced motion`);
} finally {
  await browser.close();
}
