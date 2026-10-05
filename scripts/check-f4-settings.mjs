import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/f4-settings');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://f4.opencrane.test';
const captures = [];
const settingsPages = [
  ['account', 'Account'], ['preferences', 'Preferences'],
  ['assistant', 'Assistant'], ['tools', 'My tools'],
];
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

async function interceptAssets(route) {
  const url = new URL(route.request().url());
  let filename = resolve(build, `.${url.pathname}`);
  if (!extname(url.pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) return route.abort();
  const body = await readFile(filename);
  const contentType = contentTypes[extname(filename)] ?? 'application/octet-stream';
  await route.fulfill({ body, contentType });
}

async function readFixture(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === '/auth/me') {
    await route.fulfill({ json: {
      authenticated: true,
      user: { name: 'Visual fixture account' },
    } });
    return;
  }
  await route.fulfill({ json: {} });
}

async function signedOutIdentity(route) {
  await route.fulfill({ json: { authenticated: false, user: null } });
}

async function failedIdentity(route) {
  await route.fulfill({ status: 503, json: { error: 'unavailable' } });
}

function focused(node) {
  return node === globalThis.document.activeElement;
}

function fitsViewport(node) {
  return node.scrollWidth <= node.clientWidth;
}

function ring(node) {
  const style = globalThis.getComputedStyle(node);
  return [style.outlineWidth, style.outlineColor, style.outlineOffset];
}

function animation(node) {
  return globalThis.getComputedStyle(node).animationName;
}

function fontSize(node) {
  return globalThis.getComputedStyle(node).fontSize;
}

async function fontsReady() {
  await globalThis.document.fonts.ready;
}

async function settle(node) {
  const animations = node.getAnimations();
  for (const item of animations) await item.finished;
}

async function capture(page, name, width, motion) {
  assert(await page.locator('html').evaluate(fitsViewport), 'No horizontal overflow');
  const filename = `${name}-${width}-${motion}.png`;
  await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
  captures.push(filename);
}

async function checkAccount(page, width, motion) {
  await page.goto(`${origin}/account`);
  const identityName = page.locator('.value');
  await identityName.waitFor();
  assert((await identityName.textContent()).includes('Visual fixture account'));
  await page.evaluate(fontsReady);
  assert.equal(await page.getByRole('heading', { name: 'Account', exact: true }).count(), 1);
  assert.equal(await page.getByText('Profile details not available yet', { exact: true }).count(), 1);
  assert.equal(await page.locator('oc-composer').count(), 0);
  assert.equal(await page.locator('.sidebar [aria-current="page"]').getAttribute('href'), '/account');
  if (width === 1280) {
    const sidebar = page.locator('.sidebar');
    assert.equal((await sidebar.boundingBox()).width, 232, '232px settings sidebar');
  } else {
    const back = page.locator('.mobile-back');
    const title = page.locator('.mobile-bar > span');
    const menuButton = page.getByRole('button', { name: 'Open personal settings navigation' });
    assert((await back.boundingBox()).height >= 44, 'Phone Back target is at least 44px');
    assert.equal(await back.evaluate(fontSize), '14px');
    assert((await title.boundingBox()).x < 200, 'Phone title follows the Back link on the left');
    assert((await back.boundingBox()).x < (await title.boundingBox()).x);
    assert((await menuButton.boundingBox()).width >= 44);
    assert((await menuButton.boundingBox()).height >= 44);
  }
  await capture(page, 'account', width, motion);
}

async function checkAssistant(page, width) {
  await page.goto(`${origin}/account/assistant`);
  await page.getByRole('heading', { name: 'Assistant', exact: true }).waitFor();
  await page.getByText('Your assistant is assigned in the workspace.', {
    exact: false,
  }).waitFor();
  assert.equal(await page.locator('.sidebar [aria-current="page"]').getAttribute('href'),
    '/account/assistant');
  assert.equal(await page.getByText(/P4-|P3-/u).count(), 0, 'No ticket numbers on screen');
  await capture(page, 'assistant', width, 'no-preference');
}

async function checkTitlePositions(page, width) {
  const destinations = [
    ['/account', 'Account'],
    ['/account/preferences', 'Preferences'],
    ['/account/assistant', 'Assistant'],
    ['/account/tools', 'My tools'],
  ];
  let firstTitleTop;
  for (const [pathname, label] of destinations) {
    await page.goto(`${origin}${pathname}`);
    const heading = page.getByRole('heading', { name: label, exact: true });
    await heading.waitFor();
    const titleTop = (await heading.boundingBox()).y;
    if (firstTitleTop === undefined) {
      firstTitleTop = titleTop;
    } else {
      assert.equal(titleTop, firstTitleTop, 'Settings page titles line up');
    }
    if (width === 390) {
      const menuButton = page.getByRole('button', {
        name: 'Open personal settings navigation',
      });
      const buttonBox = await menuButton.boundingBox();
      assert.equal(buttonBox.x + buttonBox.width, width - 16,
        `Phone menu button stays 16px from the right edge on ${label}`);
    }
  }
}

async function checkFailureStates(page, width) {
  await page.route('**/auth/me', signedOutIdentity);
  await page.goto(`${origin}/account`);
  await page.getByText('Your session expired', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Sign in again' }).getAttribute('href'), '/');
  await capture(page, 'session-expired', width, 'no-preference');
  await page.unroute('**/auth/me', signedOutIdentity);

  await page.route('**/auth/me', failedIdentity);
  await page.goto(`${origin}/account`);
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await page.locator('oc-shared-state .state').getAttribute('data-state'), 'failed');
  assert.equal(await page.getByRole('link', { name: 'Sign in again' }).count(), 0);
  await capture(page, 'identity-failed', width, 'no-preference');
  await page.unroute('**/auth/me', failedIdentity);
}

async function checkUnavailableTools(page, width, motion) {
  await page.goto(`${origin}/account/tools`);
  await page.getByText('Your personal tool connections are not available yet.', {
    exact: true,
  }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'My tools', exact: true }).count(), 1);
  assert.equal(await page.locator('.register-row').count(), 0);
  assert.equal(await page.getByText('Odoo Community', { exact: true }).count(), 0);
  assert.equal(await page.locator('.sidebar [aria-current="page"]').getAttribute('href'),
    '/account/tools');
  await capture(page, 'my-tools', width, motion);
}

async function checkUnavailablePreferences(page, width, motion) {
  await page.goto(`${origin}/account/preferences`);
  await page.getByText('Personal preferences are not available yet.', {
    exact: true,
  }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Preferences', exact: true }).count(), 1);
  assert.equal(await page.locator('main input, main select, main textarea, main button').count(), 0,
    'The unavailable state has no inert preference controls');
  assert.equal(await page.locator('.sidebar [aria-current="page"]').getAttribute('href'),
    '/account/preferences');
  await capture(page, 'preferences', width, motion);
}

async function checkNavigation(page, motion) {
  await page.goto(`${origin}/account`);
  const opener = page.getByRole('button', { name: 'Open personal settings navigation' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Personal settings', exact: true });
  assert(await menu.locator('h2').evaluate(focused), 'Menu starts on its title');
  const expected = motion === 'reduce' ? 'none' : 'oc-menu-hinge';
  assert.equal(await menu.evaluate(animation), expected);
  await menu.evaluate(settle);
  assert.equal((await menu.boundingBox()).width, 390);
  const links = menu.locator('nav a');
  assert.equal(await links.count(), settingsPages.length + 1);
  assert.equal((await links.nth(0).textContent()).trim(), '‹ Back to workspace');
  assert.equal(await links.nth(0).getAttribute('href'), '/workspace');
  for (let index = 0; index < settingsPages.length; index++) {
    const [pageId, label] = settingsPages[index];
    assert.equal((await links.nth(index + 1).textContent()).trim(), label);
    assert.equal(await links.nth(index + 1).getAttribute('href'),
      pageId === 'account' ? '/account' : `/account/${pageId}`);
    assert((await links.nth(index + 1).boundingBox()).height >= 44);
  }
  assert.equal(await menu.locator('[aria-current="page"]').count(), 1);
  await page.keyboard.press('Shift+Tab');
  assert(await links.last().evaluate(focused), 'Shift+Tab wraps from the menu title');
  await page.keyboard.press('Tab');
  assert(await menu.getByRole('button', { name: 'Close navigation' }).evaluate(focused),
    'Tab wraps from the last menu link to Close');
  await links.first().focus();
  assert.deepEqual(await links.first().evaluate(ring), ['2px', 'rgb(10, 132, 151)', '2px']);
  await page.keyboard.press('ArrowDown');
  assert(await links.nth(1).evaluate(focused));
  await page.keyboard.press('End');
  assert(await links.last().evaluate(focused));
  await capture(page, 'menu', 390, motion);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert(await opener.evaluate(focused), 'Escape returns focus to the menu opener');
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    for (const motion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({
        viewport: { width, height: 900 }, reducedMotion: motion,
      });
      await page.route(`${origin}/**`, interceptAssets);
      await page.route('**/auth/me', readFixture);
      await page.route('**/api/**', readFixture);
      await checkAccount(page, width, motion);
      await checkUnavailablePreferences(page, width, motion);
      await checkUnavailableTools(page, width, motion);
      if (motion === 'no-preference') {
        await checkTitlePositions(page, width);
        await checkAssistant(page, width);
        await checkFailureStates(page, width);
      }
      if (width === 390) {
        await checkNavigation(page, motion);
      }
      await page.close();
    }
  }
  const result = {
    result: 'PASS', widths: [1280, 390], motion: ['no-preference', 'reduce'], captures,
    environment: 'Built Angular assets; Chromium; disposable identity fixture; no silo stack',
    comparedFrames: ['ONB-50', 'ONB-51', 'ONB-52', 'INT-60', 'INT-61'],
    knownDifferences: [
      'The settings sidebar has no viewer name or initials row, matching the organisation shell.',
      'Account omits Email, Organisation, Role, preferred-name, assistant-card, Save and Open My tools controls.',
      'My tools omits the INT-60 and INT-61 introductory line.',
      'Preferences omits the ONB-52 Personal · only you label.',
      'The account logo is not the smaller, lighter ONB-50 mark.',
      'The Assistant page reports missing persona and setup details.',
      'ONB-51 expired state has no card or detail line; Sign in again is a text link outside it.',
      'ONB-51 failed state has a text Try again button, not a bordered button in a red card.',
      'The ONB-51 failed message differs from Nothing changed.',
      'Loading shows one Checking line instead of the ONB-51 skeleton rows.',
      'These aren\'t your settings is not built because /auth/me does not return that state.',
    ],
    scope: 'Settings shell, available identity name, and honest unavailable screen bodies',
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS F4 settings: ${captures.length} captures; shell, routes and phone menu`);
} finally {
  await browser.close();
}
