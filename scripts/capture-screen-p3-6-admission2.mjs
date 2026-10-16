import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p3-6-admission2');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p3-6-admission2.opencrane.test';
const digest = 'a'.repeat(64);
const locator = `registry.example.com/team/clock@sha256:${digest}`;
const queuedAt = '2026-10-15T10:00:00.000Z';
const checkedAt = '2026-10-15T10:01:00.000Z';
const expiresAt = '2026-10-16T10:01:00.000Z';

function check(verdict, database = false, reasonCodes = []) {
  if (verdict === 'not_run') return { verdict };
  const result = { verdict, checkedAt, expiresAt, engineVersion: 'fixture',
    reportDigest: digest };
  if (database) {
    result.databaseDigest = digest;
    result.databaseUpdatedAt = checkedAt;
  }
  if (verdict === 'fail') result.reasonCodes = reasonCodes;
  return result;
}

function resultFor(frame) {
  const result = { serverId: 'server-1', attemptId: 1, imageDigest: digest,
    platform: 'linux/amd64', queuedAt, status: 'checking' };
  if (frame === 'INT-14') {
    result.status = 'rejected';
    result.checks = { signature: check('fail', false, ['unsigned']),
      licence: check('not_run'), vulnerability: check('not_run'),
      malware: check('not_run') };
  }
  if (frame === 'INT-16') {
    result.status = 'rejected';
    result.checks = { signature: check('pass'),
      licence: check('fail', false, ['forbidden_licence']),
      vulnerability: check('pass', true), malware: check('pass', true) };
  }
  if (frame === 'INT-19') {
    result.status = 'unavailable';
    result.checks = { signature: check('pass'), licence: check('pass'),
      vulnerability: check('pass', true), malware: check('unavailable', true) };
  }
  return result;
}

async function serve(frame, route) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path === '/api/org/integrations' && request.method() === 'POST') {
    const body = request.postDataJSON();
    assert.equal(body.locator, locator);
    assert.deepEqual(body.upstream, { host: 'api.github.com', port: 443 });
    await route.fulfill({ status: 202, json: { serverId: 'server-1',
      changeRef: `chg_${body.commandId}` } });
    return;
  }
  if (path === '/api/org/integrations/server-1/admission') {
    await route.fulfill({ json: resultFor(frame) });
    return;
  }
  if (path.startsWith('/api/')) assert.fail(`Unexpected API request: ${path}`);
  await serveWebBuild(route, build);
}

function expectedText(frame) {
  if (frame === 'INT-14') return 'Signature: Failed';
  if (frame === 'INT-16') return 'Licence: Failed';
  if (frame === 'INT-19') return 'Malware: Unavailable';
  return 'Waiting for dated check results';
}

function hasFocus(element) {
  return element === element.ownerDocument.activeElement;
}

async function prepare(page, frame) {
  await page.getByLabel('Package (OCI image)').check();
  await page.getByLabel('Image pinned by sha256 digest').fill(locator);
  await page.getByLabel('Upstream host').fill('api.github.com');
  await page.getByLabel('Upstream port').fill('443');
  await page.getByRole('button', { name: 'Save package' }).click();
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.getByText('Queued 15 Oct 2026').waitFor();
  await page.getByText(expectedText(frame), { exact: false }).waitFor();
  const content = await page.locator('oc-hosted-install').textContent();
  assert(!content.includes('All four image checks passed'));
  if (frame === 'INT-14') {
    assert.equal((content.match(/Not run/gu) ?? []).length, 3);
    assert(content.includes(`sha256:${digest}`));
  }
  if (frame === 'INT-19') assert(!content.includes('Malware: Failed'));
  assert(await page.getByRole('button', { name: 'Continue' }).isDisabled());
}

async function checkTargets(page, frame, width) {
  const selector = 'oc-hosted-install button:visible, oc-hosted-install a:visible';
  const controls = await page.locator(selector).all();
  for (const control of controls) {
    const bounds = await control.boundingBox();
    assert(bounds && bounds.width >= 44 && bounds.height >= 44,
      `${frame} has a small target at ${width}px`);
  }
  const back = page.getByRole('link', { name: 'Back to integrations' });
  await back.focus();
  assert(await back.evaluate(hasFocus),
    `${frame} Back link must take keyboard focus`);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert(await back.evaluate(hasFocus),
    `${frame} Back link must be reachable by keyboard`);
}

async function capture(browser, frame, width) {
  const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-10-15T10:02:00.000Z') });
  await page.route('**/*', serve.bind(null, frame));
  try {
    await page.goto(`${origin}/org/integrations/new`);
    await prepare(page, frame);
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${frame} overflows at ${width}px`);
    await checkTargets(page, frame, width);
    const filename = `${frame}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

async function captureAnotherVersion(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-10-15T10:02:00.000Z') });
  await page.route('**/*', serve.bind(null, 'INT-14'));
  try {
    await page.goto(`${origin}/org/integrations/new`);
    await prepare(page, 'INT-14');
    const choose = page.getByRole('button', { name: 'Choose another signed version' });
    await choose.focus();
    await page.keyboard.press('Enter');
    const imageField = page.getByLabel('Image pinned by sha256 digest');
    await imageField.waitFor();
    assert(await imageField.evaluate(hasFocus),
      `The new image field must take focus after keyboard activation at ${width}px`);
    assert(await page.evaluate(pageHasNoOverflow), `The new form overflows at ${width}px`);
    const filename = `INT-14-EDIT-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const captures = [];
  for (const frame of ['INT-13', 'INT-14', 'INT-16', 'INT-19', 'INT-19-RM']) {
    for (const width of [1280, 390]) {
      captures.push(await capture(browser, frame, width));
    }
  }
  for (const width of [1280, 390]) {
    captures.push(await captureAnotherVersion(browser, width));
  }
  const receipt = '# Hosted package admission screens\n\n' +
    'Date: 16 October 2026. Fixture image digest: sha256:' + digest + '.\n\n' +
    'PASS: `npm run visual:screen-p3-6-admission2` captured checking, signature refusal, ' +
    'licence refusal, scanner unavailable and the replacement form at 1280 and 390 pixels. ' +
    'Chromium used intercepted registration and admission replies with a fixed ' +
    '15 October 2026 10:02 UTC clock and reduced motion. This was a local build, ' +
    'not a fresh install. Continue stayed disabled. Back took focus, and pressing Enter ' +
    'on Choose another signed version moved focus to the new image field. Visible actions ' +
    'measured at least 44 pixels, and no page overflowed horizontally. No admission or ' +
    'scanner command was sent.\n\n' +
    'NOT RUN: Fresh-install live qualification.\n\n' +
    `Captures: ${captures.join(', ')}.\n`;
  await writeFile(`${output}/receipt.md`, receipt);
  console.log(`Captured ${captures.join(', ')}`);
} finally {
  await browser.close();
}
