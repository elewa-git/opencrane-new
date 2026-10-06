import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

const origin = 'http://127.0.0.1:4317';
const output = resolve('docs/process/p4-7-screens/captures');
const widths = [1280, 390, 320];
const motionModes = ['no-preference', 'reduce'];
const captures = [];
let assistantRows = [];
let refuseAssistantReads = false;
let failAssistantReads = false;
let failGroupReads = false;
let refuseAssistantCreate = false;
let loseAssistantCreateReply = false;
let adminCreateApplying = false;
let memberCreateApplying = false;

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
    if (failGroupReads) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    await route.fulfill({ json: { rows: [group] } });
    return;
  }
  if (url.pathname === '/api/groups') {
    if (failGroupReads) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    await route.fulfill({ json: { rows: [group] } });
    return;
  }
  if (url.pathname === '/api/org/models') {
    await route.fulfill({ json: modelList });
    return;
  }
  if (url.pathname === '/api/assistants' && request.method() === 'POST') {
    if (loseAssistantCreateReply) {
      await route.abort('failed');
      return;
    }
    if (refuseAssistantCreate) {
      await route.fulfill({ status: 403, json: { error: 'Model unavailable' } });
      return;
    }
    const body = request.postDataJSON();
    await route.fulfill({ json: { status: 'appended', assistantId: body.assistantId,
      sequence: 1, changeId: body.commandId } });
    assistantRows = [assistantRow('claiming')];
    return;
  }
  if (url.pathname.includes('/changes/')) {
    if (url.pathname.startsWith('/api/conversations/')) {
      if (memberCreateApplying) {
        const parts = url.pathname.split('/');
        await route.fulfill({ json: { status: 'appended', conversationId: parts.at(-3),
          commandId: parts.at(-1), type: 'conversation.created', sequence: 1,
          projection: { content: 'applying', iam: 'applying' } } });
        return;
      }
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    if (adminCreateApplying) {
      const parts = url.pathname.split('/');
      await route.fulfill({ json: { status: 'appended', assistantId: parts.at(-3),
        sequence: 1, changeId: parts.at(-1),
        projection: { content: 'applying', iam: 'applying' } } });
      return;
    }
    await route.fulfill({ status: 404, json: { status: 'not_found' } });
    return;
  }
  if (url.pathname === '/api/assistants') {
    if (failAssistantReads) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    if (refuseAssistantReads) {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    await route.fulfill({ json: { rows: assistantRows } });
    return;
  }
  if (url.pathname === '/api/conversations' && request.method() === 'POST') {
    if (memberCreateApplying) {
      await route.fulfill({ json: { status: 'appended', sequence: 1 } });
      return;
    }
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
      await page.evaluate(waitForAnimationFrame);
      await assertScreenBasics(page, width);
      const file = `${state}-${width}-${motion === 'reduce' ? 'reduced' : 'normal'}.png`;
      await page.screenshot({ path: resolve(output, file), fullPage: true });
      captures.push({ state, width, motion, file });
    }
  }
}

async function assertScreenBasics(page, width) {
  const isWorkspace = await page.locator('oc-workspace').count() > 0;
  if (!isWorkspace) {
    const liveRegions = await page.locator('[role="status"][aria-live="polite"]').count();
    assert.ok(liveRegions <= 1, 'A picker or admin screen has one polite live status region');
  }
  const pageWidth = await page.locator('body').evaluate(bodyScrollWidth);
  assert.ok(pageWidth <= width, `Page overflows at ${width}px`);
  const shortTargets = await page.locator(
    'oc-shared-assistant-admin a[href], oc-shared-assistant-admin button, ' +
    'oc-shared-assistant-admin input:not([type="hidden"]):not([type="checkbox"]), ' +
    'oc-shared-assistant-admin select, oc-shared-assistant-admin textarea, ' +
    'oc-shared-assistant-picker a[href], oc-shared-assistant-picker button, ' +
    'oc-shared-assistant-picker input:not([type="hidden"]):not([type="checkbox"]), ' +
    'oc-shared-assistant-picker select, oc-shared-assistant-picker textarea',
  ).evaluateAll(targetsBelowFortyFourPixels);
  assert.deepEqual(shortTargets, [], `Interactive targets reach 44px at ${width}px`);
  const openDialogHeading = page.locator('dialog[open] h2[tabindex="-1"]').last();
  if (await openDialogHeading.count()) {
    await openDialogHeading.focus();
  } else {
    const pageHeading = page.locator('h1[tabindex="-1"]').first();
    if (await pageHeading.count()) {
      await pageHeading.focus();
    } else {
      const firstControl = page.locator(
        'oc-workspace button:not(:disabled), oc-workspace a[href]',
      ).first();
      await firstControl.focus();
    }
  }
  await page.keyboard.press('Tab');
  const focusedTag = await page.evaluate(() => globalThis.document.activeElement?.tagName ?? '');
  assert.notEqual(focusedTag, 'BODY', 'Keyboard focus reaches an interactive control');
}

function bodyScrollWidth(body) { return body.scrollWidth; }

function waitForAnimationFrame() {
  return new Promise(resolveFrame => globalThis.requestAnimationFrame(resolveFrame));
}

function targetsBelowFortyFourPixels(targets) {
  const shortTargets = [];
  for (const target of targets) {
    const bounds = target.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) continue;
    if (bounds.width < 44 || bounds.height < 44) {
      shortTargets.push(`${target.tagName.toLowerCase()} ${target.textContent?.trim() ?? ''} ` +
        `${Math.round(bounds.width)}x${Math.round(bounds.height)}`);
    }
  }
  return shortTargets;
}

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

async function prepareAdminCreate(page) {
  await page.getByLabel('Name Required').fill('Sales assistant');
  await page.getByLabel(/Model gpt-6-luna/).check();
  await page.getByRole('button', { name: 'Review assistant' }).click();
  await page.getByRole('button', { name: 'Create assistant' }).click();
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

  failGroupReads = true;
  await capturePage(page, 'admin-failed', route);
  failGroupReads = false;
  refuseAssistantCreate = true;
  await capturePage(page, 'admin-refused', route, prepareAdminCreate);
  refuseAssistantCreate = false;
  loseAssistantCreateReply = true;
  await capturePage(page, 'admin-unknown', route, prepareAdminCreate);
  loseAssistantCreateReply = false;
  adminCreateApplying = true;
  await capturePage(page, 'admin-applying', route, prepareAdminCreate);
  adminCreateApplying = false;
}

async function captureMember(page) {
  const route = '/workspace/shared';
  assistantRows = [assistantRow('ready')];
  await capturePage(page, 'member-assistant-choice', route);
  await capturePage(page, 'member-fixed-payer-review', route, prepareMemberReview);
  await capturePage(page, 'member-session-unknown', route, prepareMemberUnknown);

  failAssistantReads = true;
  await capturePage(page, 'member-failed', route);
  failAssistantReads = false;
  refuseAssistantReads = true;
  await capturePage(page, 'member-access-lost', route);
  refuseAssistantReads = false;
  memberCreateApplying = true;
  await capturePage(page, 'member-applying', route, async page => {
    await prepareMemberReview(page);
    await page.getByRole('button', { name: 'Start session' }).click();
    await page.getByText('still being applied').waitFor();
  });
  memberCreateApplying = false;

  assistantRows = [];
  await page.goto(`${origin}${route}`);
  await page.getByText('No shared assistants are available').waitFor();
  await capturePage(page, 'member-no-eligible-assistant', route);

  await chatFixture(page, 'private-team-draft');
  await capturePage(page, 'member-session-note', '/workspace?conversation=chat');
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
    assert.equal(captures.length, 114);
    const manifest = { generatedAt: new Date().toISOString(), captures };
    await writeFile(resolve(output, 'visual.json'), JSON.stringify(manifest, null, 2));
    console.log(`PASS P4-7 screen captures: ${captures.length}`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

await main();
