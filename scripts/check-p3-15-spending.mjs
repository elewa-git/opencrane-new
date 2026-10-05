import assert from 'node:assert/strict';
import { extname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = resolve('docs/process/p3-15-spending');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p3-15-spending.opencrane.test';
const states = [
  'SPD-01', 'SPD-03', 'SPD-06', 'SPD-07', 'SPD-08', 'SPD-09',
  'SPD-20', 'SPD-21', 'SPD-22', 'SPD-23', 'SPD-24', 'SPD-25',
  'SPD-26', 'SPD-27', 'SPD-28', 'SPD-30', 'SPD-31', 'SPD-32',
  'SPD-33', 'SPD-34', 'SPD-35',
];
const contentTypes = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
const budget = {
  sequence: 2, defaultPayingGroupId: 'personal-default',
  periodStart: '2026-10-01T00:00:00.000Z', todayCents: 15, monthCents: 480,
  reservedCents: 120, ceilingCents: 20000, dailyCeilingCents: 2000, ceilings: [],
};

function budgetFor(state) {
  if (state.id !== 'SPD-01') return budget;
  return { ...budget, monthCents: 0, reservedCents: 0 };
}

function makeEffect(state) {
  const observations = [];
  let reasons = ['settle_timeout'];
  let conflict = false;
  if (state === 'SPD-23') {
    reasons = ['settle_timeout', 'computer_lost', 'unknown_tariff', 'missing_usage', 'transport_failure'];
    conflict = true;
  }
  if (state === 'SPD-24') {
    observations.push({ eventId: 'event-1', outcome: 'success', costCents: 120,
      usage: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 10, priceTableId: 'prices-1' } });
  }
  if (state === 'SPD-26') {
    observations.push({ eventId: 'event-1', outcome: 'success', costCents: 120 });
    observations.push({ eventId: 'event-2', outcome: 'success', costCents: 180 });
    conflict = true;
  }
  if (state === 'SPD-28') {
    observations.push({ eventId: 'event-1', outcome: 'success', costCents: 180 });
  }
  if (state === 'SPD-31') {
    return {
      ...baseEffect(), state: 'settled', label: 'Settled', settledCents: 120,
      resolution: { outcome: 'settled', settledCents: 120,
        evidence: [{ kind: 'provider_receipt', reference: 'receipt-1', digest: 'a'.repeat(64), amountCents: 120 }] },
    };
  }
  if (state === 'SPD-33') {
    conflict = true;
    return {
      ...baseEffect(), conflict, resolution: { outcome: 'settled', settledCents: 180,
        evidence: [{ kind: 'provider_receipt', reference: 'other-receipt', digest: 'b'.repeat(64), amountCents: 180 }] },
    };
  }
  return {
    ...baseEffect(), reasons, observations, conflict,
    sequence: state === 'SPD-34' ? 4 : 3,
    state: 'outcome_unknown', label: 'Outcome unknown', resolution: null,
  };
}

function baseEffect() {
  return {
    permitId: 'permit-1', reservationId: 'permit-1', reservedAt: '2026-10-05T08:00:00.000Z',
    reservedCents: 120, settledCents: null, model: 'gpt-6.1-sol', priceTableId: 'prices-1',
    sequence: 3, state: 'outcome_unknown', label: 'Outcome unknown', conflict: false,
    reasons: ['settle_timeout'], observations: [], resolution: null,
  };
}

function fitsViewport(documentElement) {
  const pageBody = documentElement.ownerDocument.body;
  return documentElement.scrollWidth <= documentElement.clientWidth
    && pageBody.scrollWidth <= documentElement.clientWidth;
}

async function interceptAssets(route) {
  const url = new URL(route.request().url());
  let filename = resolve(build, `.${url.pathname}`);
  if (!extname(url.pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) return route.abort();
  const body = await readFile(filename);
  await route.fulfill({ body, contentType: contentTypes[extname(filename)] ?? 'application/octet-stream' });
}

function response(status, body) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function apiFixture(route, state) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path === '/api/org/models') {
    if (state.id === 'SPD-07') return route.fulfill(response(503, { status: 'unavailable' }));
    if (state.id === 'SPD-08' || state.id === 'SPD-35') return route.fulfill(response(403, { status: 'refused' }));
    if (state.id === 'SPD-03') await waitForLoadingCapture();
    if (state.id === 'SPD-06' && state.refreshFailed) return route.fulfill(response(500, { status: 'failed' }));
    return route.fulfill(response(200, { budget: budgetFor(state) }));
  }
  if (path === '/api/org/effects') {
    if (state.id === 'SPD-07') return route.fulfill(response(503, { status: 'unavailable' }));
    if (state.id === 'SPD-08' || state.id === 'SPD-35') return route.fulfill(response(403, { status: 'refused' }));
    if (state.id === 'SPD-03') await waitForLoadingCapture();
    if (state.id === 'SPD-06' && state.refreshFailed) return route.fulfill(response(500, { status: 'failed' }));
    if (state.id === 'SPD-01') return route.fulfill(response(200, { effects: [] }));
    if (state.id === 'SPD-31' && state.posted) return route.fulfill(response(200, { effects: [] }));
    if (state.id === 'SPD-31') return route.fulfill(response(200, { effects: [baseEffect()] }));
    return route.fulfill(response(200, { effects: [makeEffect(state.id)] }));
  }
  if (path.endsWith('/resolve')) return resolveCommand(route, state);
  if (path.startsWith('/api/org/effects/')) return readEffect(route, state);
  return route.fulfill(response(404, { status: 'not_found' }));
}

function waitForLoadingCapture() {
  return new Promise(finishCaptureDelay);
}

function finishCaptureDelay(resolveWait) {
  setTimeout(resolveWait, 5000);
}

async function readEffect(route, state) {
  if (state.id === 'SPD-21') await waitForLoadingCapture();
  if (state.id === 'SPD-32' && state.posted) await waitForLoadingCapture();
  if (state.id === 'SPD-32' && state.posted) {
    return route.fulfill(response(500, { status: 'failed' }));
  }
  if (state.id === 'SPD-31' && state.posted) {
    return route.fulfill(response(200, { ...makeEffect('SPD-31'), csrf: 'c'.repeat(64) }));
  }
  if (state.id === 'SPD-33' && !state.posted) {
    return route.fulfill(response(200, { ...baseEffect(), csrf: 'c'.repeat(64) }));
  }
  if (state.id === 'SPD-34' && !state.posted) {
    return route.fulfill(response(200, { ...baseEffect(), csrf: 'c'.repeat(64) }));
  }
  if (state.id === 'SPD-34' && state.posted) {
    return route.fulfill(response(200, { ...baseEffect(), sequence: 4, csrf: 'c'.repeat(64) }));
  }
  if (state.id === 'SPD-31') {
    return route.fulfill(response(200, { ...baseEffect(), csrf: 'c'.repeat(64) }));
  }
  return route.fulfill(response(200, { ...makeEffect(state.id), csrf: 'c'.repeat(64) }));
}

async function resolveCommand(route, state) {
  state.posted = true;
  if (state.id === 'SPD-30') await waitForLoadingCapture();
  if (state.id === 'SPD-31') return route.fulfill(response(202, { status: 'appended' }));
  if (state.id === 'SPD-33' || state.id === 'SPD-34') {
    return route.fulfill(response(409, { status: 'conflict' }));
  }
  if (state.id === 'SPD-32') return route.fulfill(response(503, { status: 'unavailable' }));
  return route.fulfill(response(202, { status: 'appended' }));
}

async function waitForReady(page, id) {
  if (id === 'SPD-03') {
    await page.getByText('Loading held spend…', { exact: true }).waitFor();
    return;
  }
  if (id === 'SPD-07') {
    await page.getByText('Spend evidence unavailable', { exact: true }).waitFor();
    return;
  }
  if (id === 'SPD-08' || id === 'SPD-35') {
    await page.getByText('Spending needs the Owner or Admin role.', { exact: true }).last().waitFor();
    return;
  }
  if (id === 'SPD-01') {
    await page.getByText(/No uncertain effects\. Nothing is waiting for final usage\./).waitFor();
    return;
  }
  try {
    await page.locator('oc-held-effects-list tbody tr').first().waitFor({ timeout: 4000 });
  } catch (error) {
    console.error(`Page text for ${id}: ${await page.locator('body').innerText()}`);
    throw error;
  }
}

async function openDrawer(page) {
  const checkButton = page.getByRole('button', { name: 'Check status', exact: true }).first();
  try {
    await checkButton.click({ timeout: 4000 });
  } catch (error) {
    console.error(`Drawer opener page text: ${await page.locator('body').innerText()}`);
    throw error;
  }
  await page.locator('oc-effect-resolution-drawer dialog[open]').waitFor();
}

async function prepareState(page, state) {
  if (state.id === 'SPD-06') {
    state.refreshFailed = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Showing the last spending details', { exact: false }).waitFor();
    return;
  }
  if (state.id === 'SPD-09') {
    const menuButton = page.getByRole('button', { name: 'Open organisation navigation' });
    if (await menuButton.count()) await menuButton.click();
    return;
  }
  if (state.id === 'SPD-35') return;
  if (!state.id.startsWith('SPD-2') && !state.id.startsWith('SPD-3')) return;
  if (state.id === 'SPD-20' || state.id === 'SPD-23') return;
  await openDrawer(page);
  if (state.id === 'SPD-21') {
    await page.getByText('Reading recorded evidence for permit-1…', { exact: true }).waitFor();
    return;
  }
  if (state.id === 'SPD-25') {
    await page.getByRole('radio', { name: 'Release' }).check();
    return;
  }
  if (state.id === 'SPD-27') {
    await page.getByRole('button', { name: 'Settle', exact: true }).click();
    assert.equal(await page.evaluate(() => globalThis.document.activeElement?.id), 'settle-cents',
      'Empty submit focuses the first invalid field');
    await page.locator('#settle-cents').fill('1.2');
    await page.locator('#receipt-reference').fill('bad reference');
    await page.locator('#receipt-digest').fill('abc');
    const amount = page.locator('#settle-cents');
    await amount.press('Enter');
    await page.locator('form#resolution-form').evaluate(submitForm);
    assert.equal(state.posted, false, 'Invalid submit and Enter send no resolve POST');
    return;
  }
  if (state.id === 'SPD-28' || state.id === 'SPD-30' || state.id === 'SPD-31' || state.id === 'SPD-32') {
    const amount = state.id === 'SPD-28' ? '180' : '120';
    await page.locator('#settle-cents').fill(amount);
    await page.locator('#receipt-reference').fill('receipt-1');
    await page.locator('#receipt-digest').fill('a'.repeat(64));
    if (state.id !== 'SPD-28') {
      await page.getByRole('button', { name: /Settle/ }).last().click();
      if (state.id === 'SPD-31') {
        await page.getByText('Settled €1.20 for permit-1', { exact: false }).first().waitFor();
      }
      if (state.id === 'SPD-32') {
        await page.getByText('We couldn\'t tell whether the resolution', { exact: false })
          .first().waitFor();
      }
      if (state.id === 'SPD-30') {
        await page.getByText('A resolution for this hold is still being sent.', {
          exact: false,
        }).first().waitFor();
      }
    }
  }
  if (state.id === 'SPD-33') {
    await page.locator('#settle-cents').fill('120');
    await page.locator('#receipt-reference').fill('receipt-1');
    await page.locator('#receipt-digest').fill('a'.repeat(64));
    await page.getByRole('button', { name: /Settle/ }).last().click();
    await page.getByText('This hold was already resolved', { exact: false }).first().waitFor();
  }
  if (state.id === 'SPD-34') {
    await page.locator('#settle-cents').fill('120');
    await page.locator('#receipt-reference').fill('receipt-1');
    await page.locator('#receipt-digest').fill('a'.repeat(64));
    await page.getByRole('button', { name: /Settle/ }).last().click();
    await page.getByText('The evidence changed while you were reviewing.', { exact: false }).first().waitFor();
  }
}

function submitForm(form) {
  form.requestSubmit();
}

async function assertPhoneLayout(page, width) {
  if (width > 390) return;
  assert(await page.locator('html').evaluate(fitsViewport), 'No horizontal page scroll');
  const controls = await page.locator('button, input:not([type=radio]):not([type=checkbox]), select, a').all();
  for (const control of controls) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    // Allow fractional rounding when Chromium measures a CSS 44px target.
    const roundingAllowance = 0.01;
    assert(box.width + roundingAllowance >= 44 && box.height + roundingAllowance >= 44,
      `Target is at least 44px: ${await control.evaluate(readTagAndText)} ${box.width}x${box.height}`);
  }
}

function readTagAndText(element) {
  return `${element.tagName} ${element.textContent ?? element.getAttribute('aria-label') ?? ''}`;
}

async function assertEscapeFocus(page) {
  const dialog = page.locator('oc-effect-resolution-drawer dialog[open]');
  if (await dialog.count() === 0) return;
  const rowAction = page.locator('oc-held-effects-list button').first();
  let rowActionHandle;
  if (await rowAction.count() > 0) rowActionHandle = await rowAction.elementHandle();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  if (rowActionHandle) {
    assert.equal(await rowActionHandle.evaluate(isFocused), true, 'Escape returns focus to the row');
    return;
  }
  assert.equal(await page.locator('h1').evaluate(isFocused), true, 'Escape returns focus to the page heading');
}

function isFocused(element) {
  return element === globalThis.document.activeElement;
}

async function captureState(browser, id, width, motion, captures) {
  const state = { id, posted: false, refreshFailed: false };
  const reducedMotion = motion ? 'reduce' : 'no-preference';
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
  await page.route(`${origin}/**`, interceptAssets);
  const handleApi = makeApiHandler(state);
  await page.route(`${origin}/api/**`, handleApi);
  await page.goto(`${origin}/org/spending`);
  console.log(`Capture ${id} at ${width}px (${motion ? 'reduced motion' : 'normal motion'})`);
  await waitForReady(page, id);
  await prepareState(page, state);
  await assertDrawerFooter(page, id);
  if (id !== 'SPD-03') await page.evaluate(waitForAnimations);
  await page.evaluate(waitForFonts);
  await assertReferenceLayout(page, id);
  await assertSecondaryButtonStyle(page);
  await assertPhoneLayout(page, width);
  if (width !== 320) {
    const name = `${id}-${width}-${motion ? 'reduce' : 'normal'}.png`;
    await page.screenshot({ path: `${output}/${name}`, fullPage: true });
    captures.push(name);
  }
  if (width <= 390) await assertEscapeFocus(page);
  await page.close();
}

async function assertReferenceLayout(page, id) {
  if (!id.startsWith('SPD-2') && !id.startsWith('SPD-3')) return;
  const values = page.locator('oc-held-effects-list .reference-values').first();
  if (await values.count() === 0) return;
  const text = await values.innerText();
  assert.match(text, /permit-1\ngpt-6\.1-sol\n/,
    'Permit, model and reservation time appear on separate lines');
}

async function assertSecondaryButtonStyle(page) {
  const button = page.locator('button.secondary').first();
  if (await button.count() === 0) return;
  const style = await button.evaluate(readSecondaryButtonStyle);
  assert.equal(style.color, 'rgb(11, 119, 135)', 'Secondary button text has clear contrast');
  assert.equal(style.borderStyle, 'solid', 'Secondary button has a visible border');
}

function readSecondaryButtonStyle(button) {
  const style = globalThis.getComputedStyle(button);
  return { color: style.color, borderStyle: style.borderStyle };
}

async function assertDrawerFooter(page, id) {
  if (!id.startsWith('SPD-2') && !id.startsWith('SPD-3')) return;
  const confirmButton = page.locator('dialog[open] > footer button[form="resolution-form"]');
  if (await confirmButton.count() === 0) return;
  assert.equal(await confirmButton.isVisible(), true, 'The confirm button is in the drawer footer');
}

function makeApiHandler(state) {
  return async function handleApi(route) {
    await apiFixture(route, state);
  };
}

async function waitForFonts() {
  await globalThis.document.fonts.ready;
}

async function waitForAnimations() {
  const animations = globalThis.document.getAnimations();
  const results = [];
  for (const animation of animations) results.push(animation.finished);
  await Promise.allSettled(results);
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const captures = [];
try {
  for (const width of [1280, 390, 320]) {
    for (const motion of [false, true]) {
      for (const id of states) await captureState(browser, id, width, motion, captures);
    }
  }
  const result = {
    result: 'PASS', widths: [1280, 390, 320], reducedMotion: true, captures,
    screenshotWidths: [1280, 390],
    environment: 'Built Angular assets, Chromium and mocked HTTP routes; no dev stack',
    frames: states.map(frameName),
    checks: ['No horizontal scroll at 320px and 390px', 'Visible controls are at least 44px',
      'Escape returns focus to the row opener', 'Reduced motion captures are included'],
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS P3-15 Spending: 126 viewport checks, ${captures.length} screenshots, keyboard checks`);
} finally {
  await browser.close();
}

function frameName(id) {
  return {
    id,
    result: 'adapted',
    differences: frameDifferences(id),
  };
}

function frameDifferences(id) {
  const byId = {
    'SPD-01': ['No held rows are present.', 'Monthly usage and reservations are zero.'],
    'SPD-03': ['Held spend and budget replies are still loading.', 'No budget fields or held rows are shown yet.'],
    'SPD-06': ['A refresh failed.', 'The last successful spend and budget values remain visible.'],
    'SPD-07': ['The spend and budget services did not answer.', 'No saved amounts are shown.'],
    'SPD-08': ['The Owner or Admin role is missing.', 'Protected amounts and hold references are cleared.'],
    'SPD-09': ['Organisation navigation is open.', 'The spending list remains behind the menu.'],
    'SPD-20': ['The held row is shown without its detail drawer.', 'No search or column filters are present.'],
    'SPD-21': ['Recorded evidence is still loading.', 'The drawer has no evidence or resolution form yet.'],
    'SPD-22': ['One hold reason is present.', 'No usage observation has been recorded.'],
    'SPD-23': ['Several hold reasons and conflicting evidence are present.', 'Resolution is blocked.'],
    'SPD-24': ['One recorded usage amount is shown.', 'The amount must match before settlement.'],
    'SPD-25': ['The release choice is selected.', 'A checked non-dispatch record is required.'],
    'SPD-26': ['Recorded usage amounts disagree.', 'Resolution is blocked.'],
    'SPD-27': ['Invalid fields are shown after submit and Enter.', 'The first invalid field receives focus.'],
    'SPD-28': ['The entered amount is higher than the hold.', 'The full settled amount will be recorded.'],
    'SPD-30': ['The resolution POST is still in flight.', 'The drawer offers no second command.'],
    'SPD-31': ['The hold has been settled.', 'The evidence remains available for review.'],
    'SPD-32': ['The POST reply could not be confirmed.', 'The command reference remains available for a GET check.'],
    'SPD-33': ['A different resolution is already recorded.', 'The new resolution was not applied.'],
    'SPD-34': ['The hold sequence changed during review.', 'The evidence must be refreshed.'],
    'SPD-35': ['Access was refused on a narrow screen.', 'Protected amounts and hold references are cleared.'],
  };
  return byId[id];
}
