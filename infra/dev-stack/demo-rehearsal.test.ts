import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { chromium, type Page } from 'playwright';
import { checkProviderAnswer, rehearsalStep } from './demo-rehearsal-checks.ts';
import { demoRehearsal } from './demo-rehearsal.ts';
import { sanitiseEvidence } from './sanitise-evidence.mjs';
import { RehearsalPage } from './test/rehearsal-page.ts';

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
    const contentOptions = { timeout: 30_000 };
    const missing = modelsPage.replace('<p>Model answered</p>', '');
    await page.setContent('<p>Model answered</p>' + missing, contentOptions);
    await assert.rejects(checkProviderAnswer(page), /Timeout/u);
    const syntheticKey = 'sk-synthetic-fixture-value';
    for (const html of [modelsPage + `<aside>${syntheticKey}</aside>`,
      modelsPage.replace('</oc-models>', `<p>${syntheticKey}</p></oc-models>`),
      modelsPage + '<input type="password" value="synthetic-password">']) {
      await page.setContent(html, contentOptions);
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
  async function capture() {
    return ['fixture.png'];
  }
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
  async function capture(): Promise<string[]> {
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
  async function capture() {
    return ['fixture.png'];
  }
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

async function retainsCheckerAndRestorationFailures() {
  const directory = await mkdtemp(join(tmpdir(), 'rehearsal-restoration-'));
  const owner = new RehearsalPage();
  const member = new RehearsalPage();
  const options = { origin: 'https://rehearsal.example.invalid', cookie: '', directory };
  const budget = { sequence: 1, defaultPayingGroupId: null, periodStart: null,
    todayCents: 10, monthCents: 10, reservedCents: 0, ceilingCents: 1000,
    dailyCeilingCents: 700, ceilings: [] };
  async function fetchFixture(address: string) {
    assert.equal(address, `${options.origin}/api/org/models`);
    if (owner.limited) {
      owner.restoreAttempted = true;
      return new Response('', { status: 503 });
    }
    return Response.json({ budget });
  }
  function sanitise(value: string) {
    return sanitiseEvidence(value, directory, directory);
  }
  const network = mock.method(globalThis, 'fetch', fetchFixture);
  try {
    const passed = await demoRehearsal(owner as unknown as Page, member as unknown as Page,
      options, directory, 1000, sanitise);
    assert.equal(passed, false);
    assert.equal(owner.restoreAttempted, true);
    const receipt = await readFile(`${directory}/results.json`, 'utf8');
    const steps = JSON.parse(receipt) as Array<{
      step: number; width: number; result: string; reason?: string; additionalReasons?: string[];
    }>;
    assert.equal(steps.length, 20);
    const failure = steps[8]!;
    assert.equal(failure.step, 9);
    assert.equal(failure.width, 1280);
    assert.equal(failure.result, 'FAIL');
    assert.equal(failure.reason, 'Original refusal missing [REDACTED]');
    assert.deepEqual(failure.additionalReasons, ['Demo spending unavailable']);
    for (const step of steps.slice(0, 8)) {
      assert.equal(step.result, 'PASS');
    }
    for (const step of steps.slice(9)) {
      assert.equal(step.result, 'NOT RUN');
    }
    assert.equal(receipt.includes('sk-synthetic-fixture-value'), false);
  } finally {
    network.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
}
test('the receipt keeps the checker error first when restoring company limits also fails',
  retainsCheckerAndRestorationFailures);

async function sanitisesCombinedFailuresSeparately() {
  const directory = await mkdtemp(join(tmpdir(), 'rehearsal-combined-errors-'));
  const environment = 'MODEL_KEY=synthetic-private-value\n';
  await writeFile(`${directory}/fixture.env`, environment);
  async function fail() {
    const errors = [new Error('Original refusal missing synthetic-private-value'),
      new Error('Restoration unavailable sk-synthetic-fixture-value')];
    throw new AggregateError(errors, 'Combined failures');
  }
  async function capture(): Promise<string[]> {
    throw new Error('Screenshot failed synthetic-private-value');
  }
  function sanitise(value: string) {
    return sanitiseEvidence(value, directory, directory);
  }
  function unavailableSanitiser(): string {
    throw new Error('Cannot remove private values');
  }
  try {
    const result = await rehearsalStep(fail, capture, sanitise);
    assert.equal(result.result, 'FAIL');
    assert.equal(result.reason, 'Original refusal missing [REDACTED]');
    assert.deepEqual(result.additionalReasons, ['Restoration unavailable [REDACTED]']);
    assert.equal(result.pictureReason, 'Screenshot failed [REDACTED]');
    const withheld = await rehearsalStep(fail, capture, unavailableSanitiser);
    assert.equal(withheld.result, 'FAIL');
    assert.equal(withheld.reason, 'Failure details withheld');
    assert.deepEqual(withheld.additionalReasons, ['Failure details withheld']);
    assert.equal(withheld.pictureReason, 'Failure details withheld');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('combined checker, restoration and picture errors each remove private values',
  sanitisesCombinedFailuresSeparately);

async function refusesPassWithoutPicture() {
  async function pass() {}
  async function capture() {
    return [];
  }
  function sanitise(value: string) {
    return value;
  }
  const result = await rehearsalStep(pass, capture, sanitise);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.reason, 'Step picture missing');
}
test('a successful check cannot report PASS without a saved picture', refusesPassWithoutPicture);
