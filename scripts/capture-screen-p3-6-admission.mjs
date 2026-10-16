import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p3-6-admission');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p3-6-admission.opencrane.test';
const digest = 'a'.repeat(64);
const locator = `registry.example.com/team/clock@sha256:${digest}`;
const queuedAt = '2026-10-15T10:00:00.000Z';
const checkedAt = '2026-10-15T10:01:00.000Z';
const expiresAt = '2026-10-16T10:01:00.000Z';

function normaliseText(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function pass(extra = {}) {
  return { verdict: 'pass', checkedAt, expiresAt, engineVersion: 'fixture',
    reportDigest: digest, ...extra };
}

const admitted = { serverId: 'server-1', attemptId: 1, imageDigest: digest,
  platform: 'linux/amd64', queuedAt, status: 'admitted', checks: {
    signature: pass(), licence: pass(),
    vulnerability: pass({ databaseDigest: digest, databaseUpdatedAt: checkedAt }),
    malware: pass({ databaseDigest: digest, databaseUpdatedAt: checkedAt }),
  } };

async function serve(frame, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/org/integrations' && route.request().method() === 'POST') {
    const body = route.request().postDataJSON();
    assert.equal(body.locator, locator);
    assert.equal(body.platform, 'linux/amd64');
    assert.deepEqual(body.upstream, { host: 'api.github.com', port: 443 });
    await route.fulfill({ status: 202, json: { status: 'appended', serverId: 'server-1',
      changeRef: `chg_${body.commandId}` } });
    return;
  }
  if (url.pathname === '/api/org/integrations/server-1/admission') {
    const result = frame === 'INT-12' ? admitted : { serverId: 'server-1', attemptId: 1,
      imageDigest: digest, platform: 'linux/amd64', queuedAt, status: 'checking' };
    await route.fulfill({ json: result });
    return;
  }
  if (url.pathname.startsWith('/api/')) assert.fail(`Unexpected API request: ${url.pathname}`);
  await serveWebBuild(route, build);
}

async function prepare(page, frame) {
  await page.getByLabel('Package (OCI image)').check();
  if (frame === 'INT-10') return;
  await page.getByLabel('Image pinned by sha256 digest').fill(locator);
  await page.getByLabel('Upstream host').fill('api.github.com');
  await page.getByLabel('Upstream port').fill('443');
  await page.getByRole('button', { name: 'Save package' }).click();
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.getByText('Queued 15 Oct 2026').waitFor();
  if (frame === 'INT-12') {
    const rows = page.locator('section[aria-label="Package admission"] li');
    const rowText = await rows.allTextContents();
    const visibleRows = rowText.map(normaliseText);
    assert.deepEqual(visibleRows, [
      'Signature: Passed Checked 15 Oct 2026, 10:01 UTC',
      'Licence: Passed Checked 15 Oct 2026, 10:01 UTC',
      'Vulnerability: Passed Checked 15 Oct 2026, 10:01 UTC',
      'Malware: Passed Checked 15 Oct 2026, 10:01 UTC',
    ]);
    await page.getByText('All four image checks passed. Discovery is unavailable.').waitFor();
  }
  assert(await page.getByRole('button', { name: 'Continue' }).isDisabled());
}

async function capture(browser, width, frame) {
  const page = await browser.newPage({ viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-10-15T10:02:00.000Z') });
  await page.route('**/*', serve.bind(null, frame));
  try {
    await page.goto(`${origin}/org/integrations/new`);
    await prepare(page, frame);
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${frame} overflow at ${width}px`);
    const targets = 'oc-hosted-install button:visible, oc-hosted-install input:visible, ' +
      'oc-hosted-install select:visible, oc-hosted-install a:visible, ' +
      'fieldset.sources label:visible';
    const small = await page.locator(targets)
      .evaluateAll(controls => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.outerHTML.slice(0, 90)));
    assert.deepEqual(small, [], `${frame} targets meet 44px at ${width}px`);
    const filename = `${frame}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

async function checkInvalidHost(browser) {
  let postCount = 0;
  async function serveInvalidHost(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/org/integrations' && request.method() === 'POST') {
      postCount += 1;
      await route.fulfill({ status: 400 });
      return;
    }
    await serve('INT-10', route);
  }

  const page = await browser.newPage();
  await page.route('**/*', serveInvalidHost);
  try {
    await page.goto(`${origin}/org/integrations/new`);
    await page.getByLabel('Package (OCI image)').check();
    await page.getByLabel('Image pinned by sha256 digest').fill(locator);
    await page.getByLabel('Upstream host').fill('xn--a.com');
    await page.getByLabel('Upstream port').fill('443');
    await page.getByRole('button', { name: 'Save package' }).click();
    await page.waitForLoadState('networkidle');
    assert.equal(postCount, 0, 'An invalid punycode host must not be posted');
    await page.getByText('Enter a sha256 image digest, a public upstream host and a port from 1 to 65535.')
      .waitFor({ timeout: 2_000 });
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  await checkInvalidHost(browser);
  const captures = [];
  for (const width of [1280, 390]) {
    for (const frame of ['INT-10', 'INT-11', 'INT-12']) {
      captures.push(await capture(browser, width, frame));
    }
  }
  const receipt = '# Package admission screen checks\n\n' +
    'PASS: Chromium rejected xn--a.com, showed the public host error and sent no POST. ' +
    'Captured source, queued checks and four passed checks at 1280 and 390 pixels. ' +
    'The browser used intercepted API replies, a fixed 15 October 2026 10:02 UTC clock, ' +
    'reduced motion and no development stack. The four passed rows were checked before capture. ' +
    'Package form, source choices and action targets measured at least 44 pixels, ' +
    'and the pages had no horizontal overflow. ' +
    'Continue stayed disabled after four passes because discovery is unavailable.\n\n' +
    `Files: ${captures.join(', ')}.\n`;
  await writeFile(`${output}/receipt.md`, receipt);
  console.log(`Captured ${captures.join(', ')}`);
} finally {
  await browser.close();
}
