import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/uploads-reasons');
const build = resolve('apps/web/dist/web/browser');
const cases = [
  ['unsupported_type', 'This file type is not supported. Try a supported document, image or text file.'],
  ['content_mismatch', 'This file does not match its file type. Save it in the correct format and try again.'],
  ['macros', "This file contains macros, which we don't accept. Save it without macros and try again."],
  ['embedded_object', 'This file contains an embedded object we cannot accept. Remove it and try again.'],
  ['external_link', 'This file has a link that loads outside content. Remove that link and try again.'],
  ['encrypted', 'This file is encrypted or password protected. Save an unencrypted copy and try again.'],
  ['too_large', 'This file exceeds the document inspection limits. Try a smaller or simpler file.'],
  ['too_many_parts', 'This file contains too many document parts. Try a simpler file.'],
  ['invalid_file', 'This file could not be read safely. Save a fresh copy and try again.'],
  ['unsafe_name', 'This file has an unsafe name or document part name. Rename it or save a fresh copy.'],
];

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

async function capture(browser, width, reason, expected) {
  const settings = { viewport: { width, height: 1000 }, reducedMotion: 'reduce' };
  const page = await browser.newPage(settings);
  let requests = 0;
  async function refuseUpload(route) {
    requests++;
    const response = { status: 'refused', reason };
    const status = reason === 'unsafe_name' ? 400 : 415;
    const reply = { status, contentType: 'application/json', body: JSON.stringify(response) };
    await route.fulfill(reply);
  }
  try {
    await page.route('**/*', serveAssets);
    await chatFixture(page, 'empty-selected');
    await page.route('**/api/conversations/chat/files', refuseUpload);
    await page.goto('https://uploads.opencrane.test/workspace?conversation=chat');
    await page.getByRole('button', { name: 'Attach', exact: true }).waitFor();
    const file = { name: 'sample.pptx', mimeType: 'application/octet-stream',
      buffer: Buffer.from('Sample fixture') };
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByText(expected, { exact: true }).waitFor({ timeout: 5000 });
    const retry = page.getByRole('button', { name: 'Retry upload', exact: true });
    await retry.waitFor();
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow));
    const screenshot = { path: resolve(output, `${reason}-${width}.png`), fullPage: true };
    await page.screenshot(screenshot);
    await retry.click();
    await page.getByText(expected, { exact: true }).waitFor();
    assert.equal(requests, 2);
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const [reason, expected] of cases) {
      await capture(browser, width, reason, expected);
    }
  }
} finally {
  await browser.close();
}
console.log('PASS: ten refusal reasons and Retry upload at 1280 and 390 px; intercepted API.');
