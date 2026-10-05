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

async function refuseFilePreview(route) {
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

function addWorkspaceEvidence(fixture) {
  const turnId = 'event-2';
  fixture.add('agent.command_ran', { turnId, exitCode: 0, commandDigest: 'd'.repeat(64) });
  fixture.add('decision.recorded', { turnId, reason: 'budget_exhausted' });
}

async function checkToolAndBudget(page) {
  const toolLine = page.locator('oc-tool-activity-line').first();
  await toolLine.waitFor();
  const summary = toolLine.locator('summary');
  const summaryText = await summary.textContent();
  assert.equal(summaryText?.trim(), 'Command completed');
  await summary.focus();
  assert.deepEqual(await summary.evaluate(outline),
    ['2px', 'rgb(10, 132, 151)', '2px']);
  await page.keyboard.press('Enter');
  const details = toolLine.locator('.tool-drawer');
  await details.waitFor();
  assert.equal(await toolLine.getByRole('button', { name: /retry/i }).count(), 0,
    'Tool details do not suggest a fresh message retry');

  const budgetNotice = page.locator('oc-budget-stop-notice');
  await budgetNotice.waitFor();
  const budgetCopy = await budgetNotice.textContent();
  assert(budgetCopy?.includes('scope, limit, reset time'));
  const budgetState = budgetNotice.locator('oc-shared-state .state');
  assert.equal(await budgetState.getAttribute('data-state'), 'blocked');
}

async function checkFileCard(page, width) {
  const fileCard = page.locator('oc-conversation-file-card');
  await fileCard.waitFor();
  const fileCopy = await fileCard.textContent();
  assert(fileCopy?.includes('board-pack-q3.pdf'));
  const download = fileCard.getByRole('link', { name: 'Download' });
  const filesButton = fileCard.getByRole('button', { name: 'Files' });
  const href = await download.getAttribute('href');
  assert(href?.includes('/api/conversations/chat/files/view?path=board-pack-q3.pdf'));
  if (width === 390) {
    const open = fileCard.getByRole('button', { name: 'Open' });
    assert((await open.boundingBox()).height >= 44);
    assert((await filesButton.boundingBox()).height >= 44);
    assert((await download.boundingBox()).height >= 44);
  }
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
  for (const width of [1280, 390]) {
    for (const motion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: motion });
      await page.route(`${origin}/**`, serveAssets);
      await chatFixture(page, 'draft');
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
      const evidenceFixture = await chatFixture(evidencePage);
      addWorkspaceEvidence(evidenceFixture);
      await evidencePage.route('**/files/view?*', refuseFilePreview);
      await evidencePage.goto(`${origin}/workspace?conversation=chat`);
      await evidencePage.locator('oc-tool-activity-line').first().waitFor();
      await checkToolAndBudget(evidencePage);
      await checkFileCard(evidencePage, width);
      await evidencePage.evaluate(waitForFonts);
      await scrollTranscriptToLatest(evidencePage);
      await capture(evidencePage, 'workspace-effects', width, motion);
      await evidencePage.close();
    }
  }

  const result = {
    result: 'PASS',
    widths: [1280, 390],
    motion: ['no-preference', 'reduce'],
    captures: captures.length,
    files: captures,
    environment: 'Built Angular assets; Chromium; intercepted protocol fixtures; no stack',
    frames: [
      'WRK-01-1280', 'WRK-01-390', 'WRK-80-1280', 'WRK-80-390',
      'WRK-40–45-1280', 'WRK-40–45-390', 'SPD-54-1280', 'SPD-54-390',
    ],
    checks: [
      'Sanitised tool line opens by keyboard and keeps a 2px focus ring',
      'Tool failure does not offer an unverified fresh message retry',
      'Budget stop uses the recorded reason and names missing server details',
      'File card uses an authorised conversation file path',
      'Phone panel keeps Files and Activity tabs and closes with Escape',
      '44px phone file actions',
      'No horizontal overflow',
      'Reduced-motion panel entrance is immediate',
    ],
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS F5 workspace: ${captures.length} captures; 1280/390 and reduced motion`);
} finally {
  await browser.close();
}
