import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:4317';
const output = resolve('docs/process/p4-7-screens/captures');
const widths = [1280, 390, 320];
const motionModes = ['no-preference', 'reduce'];
const captures = [];
let assistantRows = [];
let refuseAssistantReads = false;

const group = {
  groupId: 'sales', name: 'Sales team', membershipSource: 'local', position: 1,
  payingGroupId: 'sales', members: [],
  access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false,
    grants: [{ resourceType: 'model', resourceId: 'gpt-6-luna', relation: 'use' }] },
};

const modelList = { models: [{ id: 'gpt-6-luna', retired: false }] };

function assistantRow(status = 'ready', busy = false) {
  return {
    assistantId: 'team-sales-helper', ownerId: 'sales', kind: 'team',
    computerId: status === 'ready' ? 'computer-one' : null,
    generation: status === 'ready' ? 1 : 0, status,
    changedAt: '2026-10-06T12:00:00Z', name: 'Sales assistant',
    grants: [{ resourceType: 'model', resourceId: 'gpt-6-luna' }],
    payingGroupId: 'sales', canStartSession: true, busy,
  };
}

async function startWebServer() {
  const server = spawn('npm', ['run', 'dev', '-w', 'apps/web', '--', '--host',
    '127.0.0.1', '--port', '4317'], { stdio: 'ignore' });
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
  throw new Error('Angular did not start on port 4317');
}

async function routeApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith('/api/groups/')) {
    await route.fulfill({ json: { rows: [group] } });
    return;
  }
  if (url.pathname === '/api/groups') {
    await route.fulfill({ json: { rows: [group] } });
    return;
  }
  if (url.pathname === '/api/org/models') {
    await route.fulfill({ json: modelList });
    return;
  }
  if (url.pathname === '/api/assistants' && request.method() === 'POST') {
    const body = request.postDataJSON();
    await route.fulfill({ json: { status: 'appended', assistantId: body.assistantId,
      sequence: 1, changeId: body.commandId } });
    assistantRows = [assistantRow('claiming')];
    return;
  }
  if (url.pathname.includes('/changes/')) {
    await route.fulfill({ status: 404, json: { status: 'not_found' } });
    return;
  }
  if (url.pathname === '/api/assistants') {
    if (refuseAssistantReads) {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    await route.fulfill({ json: { rows: assistantRows } });
    return;
  }
  if (url.pathname === '/api/conversations' && request.method() === 'POST') {
    await route.abort('failed');
    return;
  }
  await route.fulfill({ status: 404, json: { status: 'not_found' } });
}

async function capturePage(page, state, route, preparePage = prepareNothing) {
  for (const width of widths) {
    for (const motion of motionModes) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(`${origin}${route}`);
      await preparePage(page);
      await page.waitForLoadState('networkidle');
      await assertScreenBasics(page, width);
      const file = `${state}-${width}-${motion === 'reduce' ? 'reduced' : 'normal'}.png`;
      await page.screenshot({ path: resolve(output, file), fullPage: true });
      captures.push({ state, width, motion, file });
    }
  }
}

async function assertScreenBasics(page, width) {
  const liveRegions = await page.locator('[role="status"][aria-live="polite"]').count();
  assert.ok(liveRegions <= 1, 'A screen has at most one polite live status region');
  const pageWidth = await page.locator('body').evaluate(bodyScrollWidth);
  assert.ok(pageWidth <= width, `Page overflows at ${width}px`);
}

function bodyScrollWidth(body) { return body.scrollWidth; }

async function prepareNothing() {}

async function prepareAdminReview(page) {
  await page.getByLabel('Name Required').fill('Sales assistant');
  await page.getByLabel(/Model gpt-6-luna/).check();
  await page.getByRole('button', { name: 'Review assistant' }).click();
}

async function prepareMemberReview(page) {
  await page.getByRole('button', { name: /Choose Sales assistant/ }).click();
}

async function prepareMemberUnknown(page) {
  await prepareMemberReview(page);
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByText('We could not tell whether the session was recorded').waitFor();
}

async function captureAdmin(page) {
  const route = '/org/people/groups/sales/assistants/new';
  await capturePage(page, 'admin-draft', route);
  await capturePage(page, 'admin-review', route, prepareAdminReview);

  assistantRows = [assistantRow('claiming')];
  await page.goto(`${origin}${route}`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('claiming', { exact: true }).waitFor();
  await capturePage(page, 'admin-provisioning', route);

  assistantRows = [assistantRow('ready', true)];
  await page.goto(`${origin}${route}`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Ready · Busy', { exact: true }).waitFor();
  await capturePage(page, 'admin-ready-busy', route);

  assistantRows = [assistantRow('lost')];
  await page.goto(`${origin}${route}`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('lost', { exact: true }).waitFor();
  await capturePage(page, 'admin-computer-lost', route);

  assistantRows = [assistantRow('retired')];
  await page.goto(`${origin}${route}`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('retired', { exact: true }).waitFor();
  await capturePage(page, 'admin-removed', route);

  refuseAssistantReads = true;
  await capturePage(page, 'admin-access-revoked', route);
  refuseAssistantReads = false;
}

async function captureMember(page) {
  const route = '/workspace/shared';
  assistantRows = [assistantRow('ready')];
  await capturePage(page, 'member-assistant-choice', route);
  await capturePage(page, 'member-fixed-payer-review', route, prepareMemberReview);
  await capturePage(page, 'member-session-unknown', route, prepareMemberUnknown);

  assistantRows = [];
  await page.goto(`${origin}${route}`);
  await page.getByText('No shared assistants are available').waitFor();
  await capturePage(page, 'member-no-eligible-assistant', route);
}

async function main() {
  await mkdir(output, { recursive: true });
  const server = await startWebServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/api/**', routeApi);
    await captureAdmin(page);
    await captureMember(page);
    assert.equal(captures.length, 66);
    const manifest = { generatedAt: new Date().toISOString(), captures };
    await writeFile(resolve(output, 'visual.json'), JSON.stringify(manifest, null, 2));
    console.log(`PASS P4-7 screen captures: ${captures.length}`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

await main();
