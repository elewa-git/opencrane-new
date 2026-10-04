import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

const output = resolve('docs/process/f2-drawers');
const build = resolve('apps/web/dist/web/browser');
const origin = 'http://f2.opencrane.test';
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

async function interceptAssets(route) {
  const request = route.request();
  const address = request.url();
  const url = new URL(address);
  let filename = resolve(build, `.${url.pathname}`);
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  if (!extname(url.pathname)) filename = resolve(build, 'index.html');
  try {
    const body = await readFile(filename);
    const contentType = contentTypes[extname(filename)] ?? 'application/octet-stream';
    const response = { body, contentType };
    await route.fulfill(response);
  } catch {
    await route.fulfill({ status: 404, body: 'Not found' });
  }
}

async function previewFile(route) {
  const response = {
    contentType: 'text/plain',
    body: 'Board pack notes\n\nRevenue grew this quarter. Review the renewal assumptions.',
  };
  await route.fulfill(response);
}

async function refuseView(route) {
  await route.fulfill({ status: 403, json: { status: 'refused' } });
}

async function fontsReady() {
  await globalThis.document.fonts.ready;
}

function focused(node) {
  return node === globalThis.document.activeElement;
}

function focusRing(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

function appearance(node) {
  const style = globalThis.getComputedStyle(node);
  const corner = globalThis.getComputedStyle(node, '::after');
  return {
    animation: style.animationName,
    origin: style.transformOrigin,
    shadow: style.boxShadow,
    corner: corner.width,
  };
}

function fitsViewport(node) {
  return node.scrollWidth <= node.clientWidth;
}

function animationCount(node) {
  const animations = node.getAnimations({ subtree: true });
  return animations.length;
}

async function settle(node) {
  const animations = node.getAnimations();
  for (const animation of animations) await animation.finished;
}

async function capture(page, name, width, motion) {
  const root = page.locator('html');
  assert(await root.evaluate(fitsViewport), 'No page overflow');
  const options = { path: `${output}/${name}-${width}-${motion}.png`, fullPage: true };
  await page.screenshot(options);
}

async function checkPanel(page, panel, width, motion, animation) {
  await panel.waitFor();
  const title = panel.locator(':scope > header h2[tabindex="-1"]');
  assert(await title.evaluate(focused), 'Panels start on their labelled title');
  const labelledBy = await panel.getAttribute('aria-labelledby');
  assert.equal(labelledBy, await title.getAttribute('id'));
  const style = await panel.evaluate(appearance);
  if (motion === 'reduce') {
    assert.equal(style.animation, 'none', 'Reduced-motion entrance is immediate');
    assert.equal(await panel.evaluate(animationCount), 0);
  } else {
    assert.equal(style.animation, animation);
  }
  await panel.evaluate(settle);
  assert(await panel.evaluate(fitsViewport), 'Panel contents fit');
  if (width === 390) {
    const box = await panel.boundingBox();
    assert.equal(box.x, 0);
    assert.equal(box.y, 0);
    assert.equal(box.width, 390);
    assert.equal(box.height, 900);
    const back = panel.getByRole('button', { name: '‹ Back', exact: true });
    const bounds = await back.boundingBox();
    assert(bounds.width >= 44 && bounds.height >= 44, '44px Back');
  }
}

async function checkFocusTrap(page, panel, last) {
  await last.focus();
  await page.keyboard.press('Tab');
  const first = panel.getByRole('button', { name: '‹ Back', exact: true });
  assert(await first.evaluate(focused), 'Tab wraps to Back');
  await page.keyboard.press('Shift+Tab');
  assert(await last.evaluate(focused), 'Shift+Tab wraps to the final action');
  assert.deepEqual(await last.evaluate(focusRing), ['2px', 'rgb(10, 132, 151)', '2px']);
}

async function checkFile(page, width, motion) {
  const cards = page.locator('.transcript .file-card');
  const opener = cards.filter({ hasText: 'notes.txt' });
  const button = opener.getByRole('button', { name: 'Open', exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'notes.txt', exact: true });
  const ready = sheet.getByText('Preview ready', { exact: true });
  await ready.waitFor();
  await checkPanel(page, sheet, width, motion, 'oc-sheet-lift');
  const style = await sheet.evaluate(appearance);
  assert.equal(style.corner, '12px', 'Sheets use F1’s dog-ear');
  const download = sheet.getByRole('link', { name: 'Download original file' });
  await checkFocusTrap(page, sheet, download);
  // Native modality keeps both pointer and keyboard interaction off the workspace.
  const backgroundButton = page.locator('#panel-toggle');
  await backgroundButton.evaluate(focusElement);
  assert(await download.evaluate(focused), 'Background cannot take focus');
  await capture(page, 'file-sheet', width, motion);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  assert(await button.evaluate(focused), 'Escape returns to the file opener');
  await button.click();
  await sheet.waitFor();
  const back = sheet.getByRole('button', { name: '‹ Back', exact: true });
  await back.click();
  await sheet.waitFor({ state: 'hidden' });
  assert(await button.evaluate(focused), 'Back returns to the file opener');
  await button.click();
  await sheet.waitFor();
  await button.evaluate(removeElement);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  const pageHeading = page.locator('.workspace-header h1');
  assert(await pageHeading.evaluate(focused),
    'A removed opener falls back to the page heading');
}

function removeElement(node) {
  node.remove();
}

function focusElement(node) {
  node.focus();
}

async function checkComputer(page, width, motion) {
  const opener = page.getByRole('button', { name: 'Watch your computer', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Computer view', exact: true });
  const refused = drawer.getByText('Not available', { exact: true });
  await refused.waitFor();
  await checkPanel(page, drawer, width, motion, 'oc-hinge');
  const style = await drawer.evaluate(appearance);
  assert(style.shadow.includes('-16px'), 'Right drawer has a 16px crease shadow');
  const box = await drawer.boundingBox();
  assert.equal(box.x + box.width, width, 'Drawer meets the right edge');
  assert.equal(style.origin, `${box.width}px ${box.height / 2}px`);
  const pixels = drawer.locator('canvas');
  assert.equal(await pixels.count(), 0, 'Refused view has no pixels');
  const buttons = drawer.getByRole('button');
  const last = buttons.last();
  await checkFocusTrap(page, drawer, last);
  await capture(page, 'computer-drawer', width, motion);
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert(await opener.evaluate(focused), 'Nested Escape restores the computer opener');
}

async function checkNavigation(page, motion) {
  const opener = page.getByRole('button', { name: 'Open session navigation' });
  const box = await opener.boundingBox();
  assert(box.width >= 44 && box.height >= 44, '44px menu trigger');
  assert.equal(await opener.getAttribute('aria-controls'), 'workspace-navigation');
  await opener.click();
  assert.equal(await opener.getAttribute('aria-expanded'), 'true');
  const menu = page.getByRole('dialog', { name: 'Sessions', exact: true });
  await menu.waitFor();
  const title = menu.locator('h2');
  assert(await title.evaluate(focused));
  const style = await menu.evaluate(appearance);
  assert.equal(style.animation, motion === 'reduce' ? 'none' : 'oc-menu-hinge');
  assert.equal(style.origin, '0px 450px');
  await menu.evaluate(settle);
  const links = menu.locator('nav a');
  const first = links.first();
  const second = links.nth(1);
  const last = links.last();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  assert(await second.evaluate(focused));
  await page.keyboard.press('Home');
  assert(await first.evaluate(focused));
  await page.keyboard.press('End');
  assert(await last.evaluate(focused));
  await page.keyboard.press('ArrowDown');
  assert(await first.evaluate(focused), 'Arrows wrap');
  const close = menu.getByRole('button', { name: 'Close navigation' });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  assert(await last.evaluate(focused));
  await page.keyboard.press('Tab');
  assert(await close.evaluate(focused));
  const current = menu.locator('[aria-current="page"]');
  assert.equal(await current.count(), 1);
  const bounds = await close.boundingBox();
  assert(bounds.width >= 44 && bounds.height >= 44, '44px close');
  const menuBounds = await menu.boundingBox();
  assert.equal(menuBounds.width, 390);
  await capture(page, 'navigation-menu', 390, motion);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert(await opener.evaluate(focused));
  assert.equal(await opener.getAttribute('aria-expanded'), 'false');
  await opener.click();
  await close.click();
  assert(await opener.evaluate(focused));
  await opener.click();
  const destination = menu.getByRole('link', { name: 'county-rollout', exact: true });
  await destination.click();
  await page.waitForURL('**/workspace?conversation=research');
  const openMenus = page.locator('oc-navigation-menu dialog[open]');
  assert.equal(await openMenus.count(), 0);
  await opener.click();
  const ask = menu.getByRole('button', { name: 'Ask your agent', exact: true });
  await ask.click();
  await menu.waitFor({ state: 'hidden' });
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  assert(await composer.evaluate(focused), 'Ask opens a draft and focuses it after dismissal');
}

async function checkActivityJump(page) {
  const opener = page.getByRole('button', { name: 'Session panel', exact: true });
  await opener.click();
  const panel = page.getByRole('dialog', { name: 'Session panel', exact: true });
  const activity = panel.getByRole('tab', { name: 'Activity' });
  await activity.click();
  const rows = panel.locator('.activity-row');
  const row = rows.first();
  await row.click();
  await panel.waitFor({ state: 'hidden' });
  const summaries = page.locator('.tool-line summary');
  const summary = summaries.first();
  assert(await summary.evaluate(focused), 'Activity focuses its transcript entry after dismissal');
  const tools = page.locator('.tool-line');
  const tool = tools.first();
  const expanded = await tool.getAttribute('open');
  assert.notEqual(expanded, null, 'Activity expands its transcript entry');
}

async function checkResize(page, motion) {
  await page.setViewportSize({ width: 800, height: 900 });
  const opener = page.locator('#panel-toggle[aria-expanded=false]');
  await opener.waitFor();
  await opener.click();
  const panel = page.getByRole('dialog', { name: 'Session panel', exact: true });
  await checkPanel(page, panel, 800, motion, 'oc-hinge');
  const bounds = await panel.boundingBox();
  assert.equal(bounds.x + bounds.width, 800);
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel.waitFor({ state: 'hidden' });
  const desktopToggle = page.locator('#panel-toggle');
  assert.equal(await desktopToggle.getAttribute('aria-expanded'), 'true');
  await page.setViewportSize({ width: 650, height: 900 });
  const menuOpener = page.getByRole('button', { name: 'Open session navigation' });
  await menuOpener.click();
  const menu = page.getByRole('dialog', { name: 'Sessions', exact: true });
  await menu.evaluate(settle);
  const menuBounds = await menu.boundingBox();
  assert.equal(menuBounds.width, 650, 'Menu fills intermediate mobile widths');
  await page.setViewportSize({ width: 1280, height: 900 });
  await menu.waitFor({ state: 'hidden' });
  const pageHeading = page.locator('.workspace-header h1');
  assert(await pageHeading.evaluate(focused),
    'Resizing away from a hidden mobile opener restores the heading');
}

await mkdir(output, { recursive: true });
await readFile(resolve(build, 'index.html'));
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    for (const motion of ['no-preference', 'reduce']) {
      const options = { viewport: { width, height: 900 }, reducedMotion: motion };
      const page = await browser.newPage(options);
      await page.route(`${origin}/**`, interceptAssets);
      const fixture = await chatFixture(page);
      const changedFile = { turnId: 'event-2', path: 'notes.txt' };
      fixture.add('agent.file_changed', changedFile);
      await page.route('**/files/view?*', previewFile);
      await page.route('**/api/conversations/*/view', refuseView);
      await page.goto(`${origin}/workspace?conversation=chat`);
      const fileCards = page.locator('.transcript .file-card');
      const lastFile = fileCards.last();
      await lastFile.waitFor();
      await page.evaluate(fontsReady);
      await capture(page, 'workspace', width, motion);
      await checkFile(page, width, motion);
      if (width === 390) {
        const opener = page.getByRole('button', { name: 'Session panel', exact: true });
        await opener.focus();
        await page.keyboard.press('Enter');
        const panel = page.getByRole('dialog', { name: 'Session panel', exact: true });
        await checkPanel(page, panel, width, motion, 'oc-hinge');
        await capture(page, 'session-drawer', width, motion);
        await checkComputer(page, width, motion);
        await page.keyboard.press('Escape');
        assert(await opener.evaluate(focused), 'Second Escape closes only the parent drawer');
        await checkActivityJump(page);
        await checkNavigation(page, motion);
      } else {
        await checkComputer(page, width, motion);
        await checkResize(page, motion);
      }
      await page.close();
    }
  }
  const result = {
    result: 'PASS', widths: [1280, 390], motion: ['no-preference', 'reduce'], captures: 16,
    environment: 'Built Angular assets; Chromium; read fixtures; no stack',
    checks: ['Title focus', 'Focus trap', 'Inert background', 'Nested Escape and Back restore focus',
      'Native menu links and navigation dismissal', 'Arrow keys, Home/End and wrapping',
      '44px phone targets', 'Full phone viewport', 'No horizontal overflow', '2px focus ring',
      'Right and left hinge origins', '16px crease shadow', '12px sheet dog-ear',
      'Immediate reduced-motion entrances', 'Refused computer view clears pixels',
      '650px menu and 800px panel resize and dismissal', 'Activity jump focuses transcript'],
  };
  await writeFile(`${output}/visual.json`, JSON.stringify(result, null, 2) + '\n');
  console.log('PASS F2 overlays: 16 captures; focus, navigation and reduced motion');
} finally {
  await browser.close();
}
