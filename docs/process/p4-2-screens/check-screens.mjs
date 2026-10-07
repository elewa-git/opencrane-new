import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4321';
const output = resolve('docs/process/p4-2-screens/captures');
const widths = [1280, 390, 320];
const motionModes = ['no-preference', 'reduce'];
const captures = [];
let scenario = 'owners';
let ownershipReadCount = 0;

const marieke = { memberId: 'member-1', displayName: 'Marieke Vos', role: 'owner' };
const grace = { memberId: 'member-2', displayName: 'Grace Achieng', role: 'owner' };
function ownersForCurrentScenario(confirmed = false) {
  if (scenario === 'admin-refusal') return [marieke];
  if (scenario === 'transfer-confirmed' && confirmed) return [marieke, grace];
  if (scenario === 'step-down-review' || scenario === 'last-owner-conflict') {
    return [marieke, grace];
  }
  return [marieke];
}

function ownershipReply(confirmed = false) {
  const role = scenario === 'admin-refusal' ? 'admin' : 'owner';
  return { status: 'current', owners: ownersForCurrentScenario(confirmed), sequence: 7,
    viewer: { memberId: 'member-1', role }, ready: true };
}

function transferReceipt(commandId, current = false) {
  return {
    status: 'appended', commandId, changeId: `event-${commandId}`, sequence: 8,
    recordedAt: '2026-10-06T10:50:00.000Z', actorId: 'member-1',
    type: 'ownership.transferred',
    data: { memberId: 'member-2', transferredBy: 'member-1' },
    ...(current ? { projection: { content: 'current', iam: 'current' } } : {}),
  };
}

function stepDownReceipt(commandId) {
  return { ...transferReceipt(commandId), type: 'ownership.stepped_down',
    data: { memberId: 'member-1' } };
}

async function ownershipApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === '/api/ownership' && request.method() === 'GET') {
    ownershipReadCount += 1;
    await route.fulfill({ json: ownershipReply(ownershipReadCount > 1) });
    return;
  }
  if (url.pathname === '/api/ownership' && request.method() === 'POST') {
    const command = request.postDataJSON();
    if (scenario === 'transfer-unknown') {
      await route.abort('failed');
      return;
    }
    if (scenario === 'last-owner-conflict') {
      await route.fulfill({ status: 409, json: { status: 'refused', reason: 'last_owner' } });
      return;
    }
    if (scenario === 'inactive-successor') {
      await route.fulfill({ status: 403,
        json: { status: 'refused', reason: 'active_successor_required' } });
      return;
    }
    if (scenario === 'transfer-confirmed' || scenario === 'transfer-applying') {
      await route.fulfill({ json: transferReceipt(command.commandId) });
      return;
    }
    if (scenario === 'step-down-review') {
      await route.fulfill({ json: stepDownReceipt(command.commandId) });
      return;
    }
    await route.fulfill({ status: 503, json: { status: 'unavailable' } });
    return;
  }
  if (url.pathname.startsWith('/api/ownership/changes/')) {
    const commandId = url.pathname.split('/').at(-1);
    if (scenario === 'transfer-unknown') {
      await route.fulfill({ status: 404, json: { status: 'not_found' } });
      return;
    }
    if (scenario === 'transfer-confirmed') {
      await route.fulfill({ json: transferReceipt(commandId, true) });
      return;
    }
    if (scenario === 'transfer-applying') {
      await route.fulfill({ json: transferReceipt(commandId, false) });
      return;
    }
    if (scenario === 'step-down-review') {
      await route.fulfill({ json: stepDownReceipt(commandId) });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 'not_found' } });
    return;
  }
  await route.fulfill({ status: 404, json: { status: 'not_found' } });
}

async function startWebServer() {
  const server = spawn('npm', ['run', 'dev', '-w', 'apps/web', '--', '--host',
    '127.0.0.1', '--port', '4321'], { stdio: 'ignore' });
  try {
    await waitUntilReady();
    return server;
  } catch (error) {
    server.kill('SIGTERM');
    throw error;
  }
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await wait(500);
  }
  throw new Error('Angular did not start on port 4321');
}

async function captureState(page, state, selectedScenario, prepare) {
  scenario = selectedScenario;
  ownershipReadCount = 0;
  for (const width of widths) {
    for (const motion of motionModes) {
      ownershipReadCount = 0;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(`${origin}/org/people/owners`);
      await page.waitForLoadState('networkidle');
      if (prepare) await prepare(page);
      await assertScreen(page, width);
      const motionName = motion === 'reduce' ? 'reduced' : 'normal';
      const file = `${state}-${width}-${motionName}.png`;
      await page.screenshot({ path: resolve(output, file), fullPage: true });
      captures.push({ state, width, motion, file });
    }
  }
}

async function prepareTransferEntry(page) {
  await page.getByRole('button', { name: 'Appoint an owner' }).click();
  await waitForSheetAnimations(page);
}

async function prepareTransferReview(page) {
  await prepareTransferEntry(page);
  await page.getByLabel('Successor member id').fill('member-2');
  await page.getByRole('button', { name: 'Review appointment' }).click();
  await waitForSheetAnimations(page);
}

async function prepareTransferApplying(page) {
  await prepareTransferReview(page);
  await page.getByRole('button', { name: 'Appoint this owner' }).click();
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.getByText('The change was recorded. Waiting for ownership records to update.',
    { exact: true }).waitFor();
}

async function prepareTransferUnknown(page) {
  await prepareTransferReview(page);
  await page.getByRole('button', { name: 'Appoint this owner' }).click();
  await page.getByText('We could not tell whether this change was recorded',
    { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.getByText('We could not tell whether this change was recorded',
    { exact: true }).waitFor();
}

async function prepareTransferConfirmed(page) {
  await prepareTransferReview(page);
  const opener = page.getByRole('button', { name: 'Appoint an owner' });
  await page.getByRole('button', { name: 'Appoint this owner' }).click();
  await page.getByText('member-2 is now an owner', { exact: true }).waitFor();
  const openerHandle = await opener.elementHandle();
  assert.ok(openerHandle, 'The action stays on the page after a transfer');
  await page.waitForFunction(isFocused, openerHandle);
}

async function prepareStepDownReview(page) {
  await page.getByRole('button', { name: 'Step down' }).click();
  await waitForSheetAnimations(page);
}

async function prepareLastOwnerConflict(page) {
  await page.getByRole('button', { name: 'Step down' }).click();
  await waitForSheetAnimations(page);
  await page.getByRole('button', { name: 'Step down' }).last().click();
  await page.getByText('You are the last owner', { exact: true }).waitFor();
}

async function prepareInactiveSuccessorRefusal(page) {
  await prepareTransferReview(page);
  await page.getByRole('button', { name: 'Appoint this owner' }).click();
  await page.getByText('This member is not active', { exact: true }).waitFor();
}

async function waitForSheetAnimations(page) {
  await page.locator('dialog[open]').evaluate(finishSheetAnimations);
}

async function finishSheetAnimations(dialog) {
  const animations = dialog.getAnimations({ subtree: true });
  for (const animation of animations) await animation.finished;
}

async function assertScreen(page, width) {
  const overflow = await page.locator('body').evaluate(bodyScrollWidth);
  assert.ok(overflow <= width, `The page overflows at ${width}px`);
  const statusCount = await page.locator('[role="status"][aria-live="polite"]').count();
  assert.equal(statusCount, 1, 'The page has one polite live status region');
  const shortTargets = await page.locator(
    'main button, main a[href], dialog[open] button, dialog[open] input',
  ).evaluateAll(targetsBelowFortyFourPixels);
  assert.deepEqual(shortTargets, [], `Targets reach 44px at ${width}px`);
  const tealButtons = await page.locator('button.button.primary').evaluateAll(readButtonColours);
  assert.ok(tealButtons.every(hasDarkText), 'Teal buttons use dark text');
}

function bodyScrollWidth(body) {
  return body.scrollWidth;
}

function targetsBelowFortyFourPixels(targets) {
  const shortTargets = [];
  for (const target of targets) {
    const bounds = target.getBoundingClientRect();
    const visible = bounds.width > 0 && bounds.height > 0;
    const tooSmall = Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
    if (visible && tooSmall) {
      const text = target.textContent?.trim();
      shortTargets.push({ text, width: bounds.width, height: bounds.height });
    }
  }
  return shortTargets;
}

function readButtonColours(buttons) {
  const colours = [];
  for (const button of buttons) {
    const style = globalThis.getComputedStyle(button);
    colours.push({ color: style.color, background: style.backgroundColor });
  }
  return colours;
}

function hasDarkText(button) {
  return button.color !== 'rgb(255, 255, 255)';
}

function isFocused(element) {
  return element === globalThis.document.activeElement;
}

async function main() {
  await mkdir(output, { recursive: true });
  const server = await startWebServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/api/**', ownershipApi);
    await captureState(page, 'owners', 'owners');
    await captureState(page, 'successor-entry', 'owners', prepareTransferEntry);
    await captureState(page, 'successor-review', 'owners', prepareTransferReview);
    await captureState(page, 'transfer-applying', 'transfer-applying', prepareTransferApplying);
    await captureState(page, 'transfer-unknown', 'transfer-unknown', prepareTransferUnknown);
    await captureState(page, 'two-owners-success', 'transfer-confirmed', prepareTransferConfirmed);
    await captureState(page, 'step-down-review', 'step-down-review', prepareStepDownReview);
    await captureState(page, 'last-owner-conflict', 'last-owner-conflict', prepareLastOwnerConflict);
    await captureState(page, 'inactive-member-refusal', 'inactive-successor',
      prepareInactiveSuccessorRefusal);
    await captureState(page, 'role-refusal', 'admin-refusal');
    assert.equal(captures.length, 60);
    const manifest = { generatedAt: new Date().toISOString(), captures };
    await writeFile(resolve(output, 'visual.json'), JSON.stringify(manifest, null, 2));
    console.log(`PASS P4-2 screen captures: ${captures.length}`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

await main();
