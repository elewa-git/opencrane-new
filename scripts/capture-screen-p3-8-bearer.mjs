import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p3-8-bearer');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p3-8-bearer.opencrane.test';
const row = {
  serverId: 'odoo', profileId: 'alex', profileRevision: 3, controlRevision: 0,
  status: 'saved_unverified', generation: 1, adminBlocked: false,
  serverAvailable: true, callsAvailable: false, ownerKind: 'personal', selected: true,
};

async function serve(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/my/tools/odoo/profiles') {
    const rows = state === 'INT-60' ? [] : [row];
    await route.fulfill({ json: { rows, next: null, complete: true } });
    return;
  }
  if (url.pathname === '/api/my/tools/odoo/profiles/alex') {
    await route.fulfill({ json: row });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected request: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

async function capture(browser, width, state) {
  const page = await browser.newPage({
    viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce',
  });
  await page.route('**/*', serve.bind(null, state));
  try {
    await page.goto(`${origin}/account/tools?serverId=odoo`);
    if (state === 'INT-60') {
      await page.getByText('No saved connections').waitFor();
    } else {
      await page.getByText('Profile alex').first().waitFor();
    }
    if (state === 'INT-65-safe-metadata' || state === 'INT-66') {
      await page.getByRole('button', { name: /Profile alex/u }).click();
      await page.getByText('Saved version').waitFor();
    }
    if (state === 'INT-66') {
      const opener = page.getByRole('button', { name: 'Revoke this connection' });
      await opener.click();
      await page.getByRole('dialog').waitFor();
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${state} overflow at ${width}px`);
    const small = await page.locator('button:visible, input:visible, a:visible')
      .evaluateAll((controls) => controls.filter((control) => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map((control) => control.outerHTML.slice(0, 80)));
    assert.deepEqual(small, [], `${state} controls are at least 44px at ${width}px`);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    if (state === 'INT-66') {
      const opener = page.getByRole('button', { name: 'Revoke this connection' });
      await page.getByRole('button', { name: 'Cancel' }).click();
      assert(await opener.evaluate((element) => element === element.ownerDocument.activeElement));
      await opener.click();
    }
    const filename = `${state}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const states = ['INT-60', 'INT-61', 'INT-65-safe-metadata', 'INT-66'];
  const filenames = [];
  for (const width of [1280, 390]) {
    for (const state of states) {
      filenames.push(await capture(browser, width, state));
    }
  }
  console.log(`Captured ${filenames.join(', ')}`);
} finally {
  await browser.close();
}
