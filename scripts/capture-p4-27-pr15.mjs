/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const build = resolve('apps/web/dist/web/browser');
const output = resolve('docs/process/p4-27-pr15');
const origin = 'https://navigation-capture.opencrane.test';
const checkedAt = '2026-11-08T09:40:00.000Z';
const all = { people: { read: true }, providers: { read: true }, spending: { read: true },
  integrations: { read: true }, routines: { readOwn: true }, changeHistory: { read: true } };
const restricted = { ...all, spending: { read: false }, integrations: { read: false },
  routines: { readOwn: false } };

function response(capabilities) {
  const body = { rows: [], next: null, allClear: true,
    sources: [{ name: 'people', status: 'current', checkedAt }],
    viewer: { role: 'admin' }, capabilities };
  return JSON.stringify(body);
}

function targetSizes() {
  const visible = document.querySelectorAll('.sidebar nav a, dialog[open] nav a, .mobile-bar button');
  for (const target of visible) {
    const box = target.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.width < 44 || box.height < 44) return false;
  }
  return true;
}

async function capture(browser, width, name, capabilities) {
  const page = await browser.newPage({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  async function routeRequest(route) {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/org/overview') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: response(capabilities) });
    } else if (pathname.startsWith('/api/')) {
      throw new Error(`Unexpected API request: ${pathname}`);
    } else {
      await serveWebBuild(route, build);
    }
  }
  try {
    await page.route(`${origin}/**`, routeRequest);
    await page.goto(`${origin}/org/overview`);
    await page.locator('.sidebar nav a').filter({ hasText: 'People & groups' })
      .waitFor({ state: 'attached' });
    await page.locator('.overview-tasks .overview-row').first().waitFor({ state: 'visible' });
    await page.evaluate(waitForFonts);
    if (width === 390) {
      const opener = page.getByRole('button', { name: 'Open organisation navigation' });
      await opener.click();
      await page.getByRole('dialog').waitFor();
      assert.equal(await page.getByRole('dialog').locator('a[aria-current="page"]').count(), 1);
      assert.equal(await page.getByRole('dialog').getByText('Skills & workflows').count(), 0);
      assert.equal(await page.getByRole('dialog').getByText('Spending').count(),
        capabilities.spending.read ? 1 : 0);
      assert.equal(await page.getByRole('dialog').evaluate((dialog) =>
        getComputedStyle(dialog).animationName), 'none');
      const menuLinks = page.locator('dialog[open] nav a');
      const linkCount = await menuLinks.count();
      for (let index = 0; index < linkCount; index++) {
        await menuLinks.nth(index).focus();
        assert(await menuLinks.nth(index).evaluate((link) => document.activeElement === link),
          `Tab target ${index} accepts focus`);
        if (index + 1 < linkCount) {
          await page.keyboard.press('Tab');
          assert(await menuLinks.nth(index + 1).evaluate((link) =>
            document.activeElement === link), `Tab reaches target ${index + 1}`);
        }
      }
      const longNameWraps = await page.evaluate(() => {
        const name = document.querySelector('dialog .organisation strong');
        if (!name) return false;
        const original = name.textContent;
        name.textContent = 'Alexandra Elizabeth Northwood and Catherine Elizabeth Southwood';
        const wraps = name.scrollWidth <= name.clientWidth &&
          document.documentElement.scrollWidth <= 390;
        name.textContent = original;
        return wraps;
      });
      assert(longNameWraps, 'Long organisation names wrap on a phone');
      await page.locator('dialog h2').focus();
    }
    assert(await page.evaluate(pageHasNoOverflow), `${name} has no horizontal overflow`);
    assert(await page.evaluate(targetSizes), `${name} has 44 px targets`);
    await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
    if (width === 390) {
      await page.keyboard.press('Escape');
      assert(await page.getByRole('button', { name: 'Open organisation navigation' })
        .evaluate((button) => document.activeElement === button), 'Escape returns focus');
    }
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    await capture(browser, width, 'OVR-08', all);
    await capture(browser, width, 'restricted-menu', restricted);
  }
} finally {
  await browser.close();
}
await writeFile(resolve(output, 'receipt.md'),
  '# Organisation navigation capture\n\nPASS — Four intercepted browser captures at 1280 and '
  + '390 pixels. Checked reduced motion, overflow, 44 px targets, Tab order, '
  + 'long names and phone menu focus. '
  + 'No live installation was used.\n');
