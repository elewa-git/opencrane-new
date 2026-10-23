import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { checkProviderAnswer, rehearsalStep } from './demo-rehearsal-checks.ts';
import { sanitiseEvidence } from './sanitise-evidence.mjs';

const modelsPage = `<oc-organisation-shell><main>
  <nav>Organisation</nav><oc-models><main class="provider-page">
    <h1>Models</h1><p>Model answered</p>
  </main></oc-models>
</main></oc-organisation-shell>`;

async function acceptsModelsInsideOrganisation() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(modelsPage);
    assert.equal(await page.locator('main').count(), 2);
    async function unscopedMain() {
      await page.locator('main').innerText();
    }
    await assert.rejects(unscopedMain, /strict mode violation.*resolved to 2 elements/u);
    await checkProviderAnswer(page);
  } finally {
    await browser.close();
  }
}
test('Models check accepts an answered provider inside the organisation shell',
  acceptsModelsInsideOrganisation);

async function refusesIncorrectOrExposedProvider() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(100);
    const missing = modelsPage.replace('<p>Model answered</p>', '');
    await page.setContent('<p>Model answered</p>' + missing);
    await assert.rejects(checkProviderAnswer(page), /Timeout/u);
    const syntheticKey = 'sk-synthetic-fixture-value';
    for (const html of [modelsPage + `<aside>${syntheticKey}</aside>`,
      modelsPage.replace('</oc-models>', `<p>${syntheticKey}</p></oc-models>`),
      modelsPage + '<input type="password" value="synthetic-password">']) {
      await page.setContent(html);
      await assert.rejects(checkProviderAnswer(page));
    }
  } finally {
    await browser.close();
  }
}
test('Models check requires its own answer and refuses keys or password inputs anywhere',
  refusesIncorrectOrExposedProvider);

async function retainsSafeFailureForEveryStep() {
  const directory = await mkdtemp(join(tmpdir(), 'rehearsal-check-'));
  const environment = 'MODEL_KEY=synthetic-private-value\n';
  await writeFile(`${directory}/fixture.env`, environment);
  const reasons: string[] = [];
  function sanitise(value: string) {
    return sanitiseEvidence(value, directory, directory);
  }
  async function capture() {}
  try {
    for (let index = 1; index <= 10; index++) {
      async function fail() {
        throw new Error(`Step ${index}: strict mode violation; resolved to 2 elements\n` +
          'synthetic-private-value sk-synthetic-fixture-value');
      }
      const result = await rehearsalStep(fail, capture, sanitise);
      assert.equal(result.result, 'FAIL');
      assert.equal(result.reason, `Step ${index}: strict mode violation; resolved to 2 elements\n` +
        '[REDACTED] [REDACTED]');
      reasons.push(result.reason!);
    }
    const path = `${directory}/results.json`;
    await writeFile(path, JSON.stringify(reasons));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), reasons);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('each of the ten steps retains its error message with private values removed',
  retainsSafeFailureForEveryStep);

async function retainsErrorWhenPicturesFail() {
  function sanitise(value: string) {
    return value;
  }
  async function fail() {
    throw new Error('Original checker failure');
  }
  async function capture() {
    throw new Error('Screenshot failed');
  }
  const result = await rehearsalStep(fail, capture, sanitise);
  assert.equal(result.reason, 'Original checker failure');
  assert.equal(result.pictureReason, 'Screenshot failed');
  assert.equal(result.result, 'FAIL');
  async function pass() {}
  const pictureFailure = await rehearsalStep(pass, capture, sanitise);
  assert.equal(pictureFailure.result, 'FAIL');
  assert.equal(pictureFailure.reason, 'Screenshot failed');
}
test('picture failures retain the checker error and cannot pass a step', retainsErrorWhenPicturesFail);

async function withholdsUnsafeErrors() {
  async function fail() {
    throw new Error('synthetic-private-value');
  }
  async function capture() {}
  function sanitise(): string {
    throw new Error('Cannot remove private values');
  }
  const result = await rehearsalStep(fail, capture, sanitise);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.reason, 'Failure details withheld');
}
test('a failed sanitiser withholds error details', withholdsUnsafeErrors);

async function refusesUnsafeSlots() {
  const { spawnSync } = await import('node:child_process');
  for (const id of [undefined, '', 'owner', '3']) {
    const env = { PATH: process.env['PATH'], DEV_STACK_ID: id, DEMO_ALLOWANCE_CENTS: '100',
      DEV_STACK_DIR: '/invalid-demo-configuration' };
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/demo-smoke-preload.mjs', 'infra/dev-stack/demo-rehearsal-run.ts'];
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Demo tasks require an explicit secondary id/u);
    assert.equal(result.stdout, '');
  }
}
test('rehearsal refuses missing, owner and invalid slots before reading settings', refusesUnsafeSlots);
