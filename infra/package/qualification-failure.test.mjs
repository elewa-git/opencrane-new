import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

async function capturesBeforeClosing() {
  const { captureJourneyFailure, closeAfterJourney } =
    await import('./qualification-failure.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'qualification-failure-'));
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<input type="password" value="planted-private-value">');
    const options = { step: 'member 1280px draft', path: join(directory, 'failure.png') };
    let failure;
    async function run() {
      await page.getByText('Missing draft').waitFor({ timeout: 50 });
    }
    async function capture(error) {
      failure = await captureJourneyFailure(page, error, options);
    }
    await assert.rejects(closeAfterJourney(context, run, capture), { name: 'TimeoutError' });
    assert.equal(page.isClosed(), true);
    assert.deepEqual(failure, { step: options.step, result: 'FAIL', code: 'BROWSER_TIMEOUT',
      screenshot: 'PASS' });
    const png = await readFile(options.path);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.doesNotMatch(JSON.stringify(failure), /planted|Missing draft|locator|password/);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function keepsOnlyKnownCodesAndSteps() {
  const { journeyFailure } = await import('./qualification-failure.mjs');
  const privateError = new Error('private page text token=planted');
  privateError.code = 'PLANTED_SECRET';
  assert.deepEqual(journeyFailure('private stage token=planted', privateError), {
    step: 'unknown step', result: 'FAIL', code: 'BROWSER_ERROR',
  });
  const assertion = new Error('private assertion details');
  assertion.code = 'ERR_ASSERTION';
  assert.equal(journeyFailure('member 390px reply', assertion).code, 'ASSERTION_FAILED');
  privateError.message = 'page.goto: net::ERR_CONNECTION_REFUSED private text';
  assert.equal(journeyFailure('member 1280px workspace', privateError).code,
    'BROWSER_NETWORK_ERROR');
}

async function reportsCaptureFailureWithoutReplacingOriginalError() {
  const { captureJourneyFailure, closeAfterJourney } =
    await import('./qualification-failure.mjs');
  const calls = [];
  const original = new Error('private error');
  const context = { async close() { calls.push('close'); } };
  const page = { locator() { return {}; }, async screenshot() { throw new Error('private'); } };
  let failure;
  async function run() { throw original; }
  async function capture(error) {
    failure = await captureJourneyFailure(page, error,
      { step: 'admin 390px reply', path: 'unused.png' });
    calls.push('capture');
  }
  await assert.rejects(closeAfterJourney(context, run, capture), original);
  assert.deepEqual(calls, ['capture', 'close']);
  assert.equal(failure.screenshot, 'FAIL');
  assert.equal(failure.code, 'BROWSER_ERROR');
}

test('keeps a safe specific failure and real PNG before context closure', capturesBeforeClosing);
test('private messages, codes and steps cannot enter failure receipts', keepsOnlyKnownCodesAndSteps);
test('records unavailable screenshot without hiding the journey failure',
  reportsCaptureFailureWithoutReplacingOriginalError);
