import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

const output = resolve(process.env.F2_CAPTURE_DIR ?? 'docs/process/f2-drawers');
const build = resolve('apps/web/dist/web/browser');
const overlayBuild = resolve('apps/web/dist/overlays/browser');
const captures = [];
const origin = 'https://f2.opencrane.test';
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

async function interceptAssets(route) {
  const request = route.request();
  const address = request.url();
  const url = new URL(address);
  const assetRoot = url.pathname.startsWith('/overlay-fixture') ? overlayBuild : build;
  const pathname = url.pathname.replace('/overlay-fixture', '');
  let filename = resolve(assetRoot, `.${pathname}`);
  if (!extname(pathname)) filename = resolve(assetRoot, 'index.html');
  if (!filename.startsWith(`${assetRoot}/`)) {
    await route.abort();
    return;
  }
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
  const body = node.querySelector('.body') ?? node;
  const corner = globalThis.getComputedStyle(body, '::after');
  return {
    animation: style.animationName,
    origin: style.transformOrigin,
    shadow: style.boxShadow,
    corner: corner.width,
    radius: style.borderRadius,
    background: style.backgroundColor,
    crease: globalThis.getComputedStyle(node, '::before').backgroundImage,
    creaseDisplay: globalThis.getComputedStyle(node, '::before').display,
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
  captures.push(`${name}-${width}-${motion}.png`);
}

async function checkPanel(page, panel, width, motion, animation) {
  await panel.waitFor();
  const title = panel.locator(':scope > header h2[tabindex="-1"]');
  assert(await title.evaluate(focused), 'Panels start on their labelled title');
  assert.equal(await panel.locator(':scope > header button').count(), 1,
    'Every header has one close action');
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
  assert.deepEqual(await panel.evaluate(scrollBehaviour), {
    root: 'hidden', body: 'hidden', overscroll: 'contain',
  });
  await checkTextContrast(panel);
  assert(await panel.evaluate(fitsViewport), 'Panel contents fit');
  if (width === 390) {
    const box = await panel.boundingBox();
    assert.equal(box.x, 0);
    assert.equal(box.y, 0);
    assert.equal(box.width, 390);
    assert.equal(box.height, 900);
    const back = panel.locator(':scope > header button');
    const bounds = await back.boundingBox();
    assert(bounds.width >= 44 && bounds.height >= 44, '44px Back');
  }
}

async function checkFocusTrap(page, panel, last) {
  await last.focus();
  await page.keyboard.press('Tab');
  const first = panel.locator(':scope > header button');
  assert(await first.evaluate(focused), 'Tab wraps to Back');
  await page.keyboard.press('Shift+Tab');
  assert(await last.evaluate(focused), 'Shift+Tab wraps to the final action');
  assert.deepEqual(await last.evaluate(focusRing), ['2px', 'rgb(10, 132, 151)', '2px']);
}

function addFocusTargets(panel) {
  const body = panel;
  const details = globalThis.document.createElement('details');
  const summary = globalThis.document.createElement('summary');
  summary.textContent = 'Fixture disclosure';
  details.append(summary);
  const editable = globalThis.document.createElement('div');
  editable.contentEditable = 'true';
  editable.textContent = 'Editable fixture';
  const audio = globalThis.document.createElement('audio');
  audio.controls = true;
  const video = globalThis.document.createElement('video');
  video.controls = true;
  body.append(details, editable, audio, video);
}

async function checkAdditionalFocusTargets(page, panel) {
  await panel.evaluate(addFocusTargets);
  const title = panel.locator(':scope > header h2');
  // These intrinsic targets have no explicit tabindex; the trap must still include them.
  const targets = panel.locator('summary, [contenteditable], audio, video');
  const last = targets.last();
  await title.focus();
  await page.keyboard.press('Shift+Tab');
  assert(await last.evaluate(focused), 'Title wraps backwards to the final media control');
  for (const target of await targets.all()) {
    await target.focus();
    assert(await target.evaluate(focused), 'Intrinsic target receives focus');
  }
}

function scrollBehaviour(panel) {
  const body = panel.querySelector('.body') ?? panel.querySelector('nav');
  return {
    root: globalThis.getComputedStyle(globalThis.document.documentElement).overflow,
    body: globalThis.getComputedStyle(globalThis.document.body).overflow,
    overscroll: globalThis.getComputedStyle(body).overscrollBehavior,
  };
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
  const back = sheet.getByRole('button', { name: 'Close preview', exact: true });
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
  const refused = drawer.getByText('Unavailable', { exact: true });
  await refused.waitFor();
  await checkPanel(page, drawer, width, motion, 'oc-sheet-lift');
  await checkComputerBounds(drawer, width);
  const pixels = drawer.locator('canvas');
  assert.equal(await pixels.count(), 0, 'Refused view has no pixels');
  const buttons = drawer.getByRole('button');
  const last = buttons.last();
  await checkFocusTrap(page, drawer, last);
  await capture(page, 'computer-sheet', width, motion);
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
  const menu = page.getByRole('dialog', { name: 'Sessions', exact: true });
  await menu.waitFor();
  assert.equal(await opener.getAttribute('aria-expanded'), 'true');
  const title = menu.locator(':scope > header h2');
  assert(await title.evaluate(focused));
  const style = await menu.evaluate(appearance);
  assert.equal(style.animation, motion === 'reduce' ? 'none' : 'oc-menu-hinge');
  assert.equal(style.origin, '0px 450px');
  assert.equal(style.background, 'rgb(238, 241, 242)', 'Menu has an opaque rail surface');
  await menu.evaluate(settle);
  const links = menu.locator('nav button, nav a');
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
  assert.equal(await current.evaluate(fontWeight), '600');
  assert.equal(await close.evaluate(fontSize), '19px');
  const menuStyle = await menu.evaluate(appearance);
  assert(menuStyle.crease.includes('270deg'), 'Menu has its right-edge crease');
  await checkTextContrast(menu);
  for (const status of ['Working', 'Done', 'Closed', 'Failed']) {
    assert(await menu.getByText(status, { exact: true }).count() > 0);
  }
  assert.equal(await menu.getByRole('link').count(), 2, 'Only Settings and Account are links');
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
  const destination = menu.locator('.session-row').filter({ hasText: 'county-rollout' });
  await destination.click();
  await page.waitForURL('**/workspace?conversation=research');
  const openMenus = page.locator('oc-navigation-menu dialog[open]');
  assert.equal(await openMenus.count(), 0);
  const selectedComposer = page.getByRole('textbox', { name: 'Message your agent' });
  assert(await selectedComposer.evaluate(focused), 'Session selection focuses the composer');
  await opener.click();
  const ask = menu.locator('.ask');
  await ask.click();
  await menu.waitFor({ state: 'hidden' });
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  assert(await composer.evaluate(focused), 'Ask opens a draft and focuses it after dismissal');
}

async function checkActivityJump(page) {
  const opener = page.getByRole('button', { name: 'Session panel', exact: true });
  await opener.click();
  const panel = page.getByRole('dialog', { name: 'Session', exact: true });
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
  const panel = page.getByRole('dialog', { name: 'Session', exact: true });
  await checkPanel(page, panel, 800, motion, 'oc-hinge');
  const bounds = await panel.boundingBox();
  assert.equal(bounds.x + bounds.width, 800);
  const drawerStyle = await panel.evaluate(appearance);
  assert(drawerStyle.crease.includes('90deg'), 'Drawer has a 16px inner crease');
  assert(drawerStyle.shadow.includes('-28px'), 'Drawer has the handoff outer shadow');
  await capture(page, 'session-drawer', 800, motion);
  const viewerFixture = await computerFixture(page);
  viewerFixture.release();
  await panel.getByRole('button', { name: 'Watch your computer' }).click();
  const viewer = page.getByRole('dialog', { name: 'Computer view', exact: true });
  await viewerFixture.start();
  await viewer.getByText('Viewing', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('dialog[open]').count(), 0, 'No invisible child modal');
  await page.waitForFunction(noModal);
  await assertClosed(viewerFixture);
  assert.equal(await page.locator('oc-live-view').count(), 1, 'One desktop panel copy');
  await page.getByRole('textbox', { name: 'Message your agent' }).click();
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

function fontWeight(node) {
  return globalThis.getComputedStyle(node).fontWeight;
}

function fontSize(node) {
  return globalThis.getComputedStyle(node).fontSize;
}

function noModal() {
  return globalThis.document.querySelector('dialog[open]') === null;
}

function textContrasts(root) {
  function colour(value) {
    const parts = value.match(/[\d.]+/g);
    return parts.map(Number);
  }
  function luminance(channels) {
    function linear(channel) {
      const value = channel / 255;
      if (value <= 0.04045) return value / 12.92;
      return ((value + 0.055) / 1.055) ** 2.4;
    }
    const values = channels.map(linear);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  }
  const failures = [];
  const walker = globalThis.document.createTreeWalker(root, globalThis.NodeFilter.SHOW_TEXT);
  let text = walker.nextNode();
  while (text) {
    const element = text.parentElement;
    if (text.textContent.trim() && element.getClientRects().length > 0
      && !element.closest('[aria-hidden=true], .sr-only')) {
      const foreground = colour(globalThis.getComputedStyle(element).color);
      let background = [255, 255, 255];
      let ancestor = element;
      while (ancestor) {
        const fill = colour(globalThis.getComputedStyle(ancestor).backgroundColor);
        if (fill.length === 3 || fill[3] === 1) {
          background = fill;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      const light = luminance(foreground);
      const dark = luminance(background);
      const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      if (ratio < 4.5) failures.push({ text: text.textContent.trim(), ratio });
    }
    text = walker.nextNode();
  }
  return failures;
}

async function checkTextContrast(panel) {
  assert.deepEqual(await panel.evaluate(textContrasts), [], 'All overlay text reaches 4.5:1');
}

async function checkComputerBounds(sheet, width) {
  const box = await sheet.boundingBox();
  const style = await sheet.evaluate(appearance);
  if (width === 1280) {
    assert.equal(box.x, 18);
    assert.equal(box.y, 18);
    assert.equal(box.width, width - 36, 'Computer fills the width inside 18px padding');
    assert.equal(box.height, 864);
    assert.equal(style.radius, '12px');
  }
  assert(style.shadow.includes('60px'), 'Sheet shadow matches the handoff');
}

async function assertClosed(fixture) {
  const timeout = new Promise(rejectOnTimeout);
  function rejectOnTimeout(_resolve, reject) {
    const error = new Error('Viewer connection did not close');
    const fail = reject.bind(undefined, error);
    setTimeout(fail, 5000).unref();
  }
  await Promise.race([fixture.closed, timeout]);
}

function exposeFixtureSocketMethods() {
  const prototype = globalThis.WebSocket.prototype;
  const inherited = Object.getPrototypeOf(prototype);
  const properties = [
    'send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen',
  ];
  // Playwright adds a subclass; noVNC 1.5 checks only the immediate prototype's properties.
  for (const property of properties) {
    if (Object.hasOwn(prototype, property)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(inherited, property);
    if (descriptor) Object.defineProperty(prototype, property, descriptor);
  }
}

async function computerFixture(page) {
  await page.evaluate(exposeFixtureSocketMethods);
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let activeSocket;
  let release;
  function holdAdmission(resolve) {
    release = resolve;
  }
  const admission = new Promise(holdAdmission);
  async function admitView(route) {
    await admission;
    const response = { json: { ticket: 'fixture-ticket' } };
    await route.fulfill(response);
  }
  function attachViewer(socket) {
    activeSocket = socket;
    let step = 0;
    function handshake() {
      if (step === 0) {
        socket.send(Buffer.from([1, 1]));
      } else if (step === 1) {
        socket.send(Buffer.alloc(4));
      } else if (step === 2) {
        const init = Buffer.alloc(24);
        init.writeUInt16BE(1024, 0);
        init.writeUInt16BE(768, 2);
        init[4] = 32;
        init[5] = 24;
        init[7] = 1;
        init.writeUInt16BE(255, 8);
        init.writeUInt16BE(255, 10);
        init.writeUInt16BE(255, 12);
        init[14] = 16;
        init[15] = 8;
        socket.send(init);
      }
      step++;
    }
    function disconnected() {
      resolveClosed();
    }
    socket.onMessage(handshake);
    socket.onClose(disconnected);

  }
  async function start() {
    const canvas = page.locator('oc-live-view .display canvas');
    await canvas.waitFor({ state: 'attached' });
    activeSocket.send(Buffer.from('RFB 003.008\n'));
  }
  function revoke() {
    activeSocket.close({ code: 4003, reason: 'Access changed' });
  }
  await page.route('**/api/conversations/*/view', admitView);
  await page.routeWebSocket('**/ws/conversations/*/view', attachViewer);
  return { closed, revoke, release, start };
}

async function checkComputerStates(page, width, motion) {
  await page.setViewportSize({ width, height: 900 });
  if (width === 390) await page.locator('#panel-toggle').click();
  const fixture = await computerFixture(page);
  const opener = page.getByRole('button', { name: 'Watch your computer', exact: true });
  await opener.click();
  const sheet = page.getByRole('dialog', { name: 'Computer view', exact: true });
  await sheet.getByText('Connecting', { exact: true }).waitFor();
  await checkPanel(page, sheet, width, motion, 'oc-sheet-lift');
  await capture(page, 'computer-connecting', width, motion);
  fixture.release();
  await fixture.start();
  await sheet.getByText('Viewing', { exact: true }).waitFor();
  await checkPanel(page, sheet, width, motion, 'oc-sheet-lift');
  await checkComputerBounds(sheet, width);
  if (width === 1280) {
    const display = await sheet.locator('.display').boundingBox();
    assert(display.width > 1000, 'Desktop pixels are not constrained to a 480px drawer');
    assert(display.height > 600, 'The display fills the remaining sheet height');
  }
  if (width === 390) {
    const display = await sheet.locator('.display').boundingBox();
    const tools = await sheet.locator('.tools').boundingBox();
    assert(display.width > display.height, 'Phone display stays landscape');
    assert(tools.y + tools.height <= display.y, 'Phone toolbar precedes the display');
  }
  await capture(page, 'computer-viewing', width, motion);
  fixture.revoke();
  await sheet.getByText('Access changed', { exact: true }).waitFor();
  assert.equal(await sheet.locator('canvas').count(), 0);
  await capture(page, 'computer-access-changed', width, motion);
  await page.keyboard.press('Escape');
  if (width === 390) await page.keyboard.press('Escape');
}

async function checkFilesOpener(page) {
  const files = page.locator('.transcript .file-card').first().getByRole('button', {
    name: 'Files', exact: true,
  });
  await files.click();
  const panel = page.getByRole('dialog', { name: 'Session', exact: true });
  await panel.waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert(await files.evaluate(focused), 'Files restores the actual opener');
}

async function checkSharedPanels(page, width, motion) {
  for (const kind of ['sheet', 'drawer']) {
    const query = kind === 'drawer' ? '?drawer' : '';
    await page.goto(`${origin}/overlay-fixture/${query}`);
    const panel = page.getByRole('dialog');
    await page.evaluate(fontsReady);
    const animation = kind === 'drawer' ? 'oc-hinge' : 'oc-sheet-lift';
    await checkPanel(page, panel, width, motion, animation);
    const close = panel.getByRole('button', { name: 'Cancel', exact: true });
    assert.equal(await close.count(), 1, 'Cancel has no spoken chevron');
    const style = await panel.evaluate(appearance);
    if (kind === 'drawer') {
      if (width === 390) {
        assert.equal(style.creaseDisplay, 'none');
      } else {
        assert(style.crease.includes('90deg'));
      }
      assert(style.shadow.includes('-28px'));
      const box = await panel.boundingBox();
      assert.equal(style.origin, `${box.width}px ${box.height / 2}px`);
    } else {
      assert.equal(style.corner, '12px');
      assert(style.shadow.includes('60px'));
    }
    await capture(page, `shared-${kind}`, width, motion);
    if (kind === 'drawer') await checkAdditionalFocusTargets(page, panel);
    await close.click();
    await panel.waitFor({ state: 'hidden' });
  }
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
        const panel = page.getByRole('dialog', { name: 'Session', exact: true });
        await checkPanel(page, panel, width, motion, 'oc-hinge');
        assert.equal(await panel.locator('.panel-header').count(), 0);
        assert.equal(await panel.locator(':scope > .body > :first-child').getAttribute('class'),
          'panel-tabs', 'The Session header is followed directly by tabs');
        await capture(page, 'session-drawer', width, motion);
        await checkComputer(page, width, motion);
        await page.keyboard.press('Escape');
        assert(await opener.evaluate(focused), 'Second Escape closes only the parent drawer');
        await checkFilesOpener(page);
        await checkActivityJump(page);
        await checkNavigation(page, motion);
      } else {
        assert.equal(await page.locator('oc-live-view').count(), 1);
        await checkComputer(page, width, motion);
        await checkResize(page, motion);
      }
      await page.goto(`${origin}/workspace?conversation=chat`);
      await page.locator('.transcript .file-card').last().waitFor();
      await checkComputerStates(page, width, motion);
      await checkSharedPanels(page, width, motion);
      await page.close();
    }
  }
  const result = {
    result: 'PASS',
    widths: [1280, 390],
    motion: ['no-preference', 'reduce'],
    captures: captures.length,
    files: captures,
    environment: 'Built Angular assets; Chromium; read fixtures; no stack',
    frames: [
      'INT-08-390', 'INT-35-1280', 'INT-35-390', 'INT-50-1280', 'INT-50-390',
      'WRK-07-390', 'WRK-84-1280', 'WRK-84-390',
      'WRK-51-1280', 'WRK-51-390', 'WRK-52-1280', 'WRK-52-390',
      'WRK-54-1280', 'WRK-54-390', 'WRK-55-1280', 'WRK-55-390',
    ],
    checks: ['Title focus', 'Focus trap', 'Inert background', 'Nested Escape and Back restore focus',
      'Guarded menu session buttons and navigation dismissal', 'Arrow keys, Home/End and wrapping',
      '44px phone targets', 'Full phone viewport', 'No horizontal overflow', '2px focus ring',
      'Right and left hinge origins', 'Computer sheet 18px inset and 12px radius',
      'Text contrast at least 4.5:1', 'One close action per header', 'Files opener focus',
      '16px inner crease and outer shadow', '12px sheet dog-ear',
      'One Session header followed by tabs', 'Scroll lock and overscroll containment',
      'Disclosure, editable and media focus targets',
      'Immediate reduced-motion entrances', 'Refused computer view clears pixels',
      '650px menu and nested viewer 800px to 1280px dismissal', 'Activity jump focuses transcript'],
  };
  await writeFile(`${output}/visual.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS F2 overlays: ${captures.length} captures; focus, navigation and reduced motion`);
} finally {
  await browser.close();
}
