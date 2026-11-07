import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const build = resolve('apps/web/dist/web/browser');
const origin = 'https://maintenance.opencrane.test';
const browser = await chromium.launch();

function noticeFitsViewport(element) {
  const bounds = element.getBoundingClientRect();
  return bounds.right <= globalThis.innerWidth;
}

async function checkViewport(width) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
  try {
    await page.clock.install();
    async function serveAssets(route) {
      await serveWebBuild(route, build);
    }
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'folding', { dispatcherReady: false });
    await page.goto(`${origin}/workspace?conversation=chat`);
    await fixture.waitForReadySocket();
    await page.evaluate(waitForFonts);

    const notice = page.locator('.connection-strip');
    await notice.waitFor();
    assert.match(await notice.innerText(), /Starting your computer/);
    await page.clock.runFor(15_000);
    assert.match(await notice.innerText(),
      /The assistant service is waiting for maintenance\. Your message is saved and will run afterwards\./);
    assert.equal(await notice.locator('small').count(), 0);
    assert(await page.evaluate(pageHasNoOverflow), `${width}px page overflows`);
    const fits = await notice.evaluate(noticeFitsViewport);
    assert(fits, `${width}px notice overflows`);
    await page.screenshot({ path: `/tmp/opencrane-895-${width}.png` });
  } finally {
    await page.close();
  }
}

try {
  for (const width of [1280, 390]) await checkViewport(width);
} finally {
  await browser.close();
}
console.log('PASS maintenance notice with a waiting dispatcher at 1280 and 390 px');
