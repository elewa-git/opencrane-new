import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/chat-drag-drop');
const build = resolve('apps/web/dist/web/browser');

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function createFileDrag() {
  const transfer = new globalThis.DataTransfer();
  transfer.items.add(new File([''], 'notes.txt', { type: 'text/plain' }));
  return transfer;
}

async function capture(browser, width) {
  const page = await browser.newPage({
    viewport: { width, height: 1000 }, reducedMotion: 'reduce',
  });
  try {
    await page.route('**/*', serveAssets);
    await chatFixture(page, 'empty-selected');
    await page.goto('https://chat.opencrane.test/workspace?conversation=chat');
    await page.getByRole('button', { name: 'Attach', exact: true }).waitFor();
    await page.evaluate(waitForFonts);
    const transfer = await page.evaluateHandle(createFileDrag);
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    await transcript.dispatchEvent('dragenter', { dataTransfer: transfer });
    await transcript.dispatchEvent('dragover', { dataTransfer: transfer });
    const label = page.getByText('Drop files to add them', { exact: true });
    if (width > 700) {
      await label.waitFor();
      const composer = page.locator('.composer');
      assert.equal(await composer.evaluate(hasDropOutline), true);
    } else {
      assert.equal(await label.count(), 0);
      await page.getByRole('button', { name: 'Attach', exact: true }).click();
      await page.getByRole('button', { name: 'Upload from computer' }).waitFor();
    }
    assert(await page.evaluate(pageHasNoOverflow));
    await page.screenshot({ path: resolve(output, `drop-${width}.png`), fullPage: true });
  } finally {
    await page.close();
  }
}

function hasDropOutline(element) {
  return globalThis.getComputedStyle(element).outlineStyle === 'dashed';
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    await capture(browser, width);
  }
} finally {
  await browser.close();
}
console.log('PASS: intercepted file drag at 1280 px and unchanged attachment controls at 390 px.');
