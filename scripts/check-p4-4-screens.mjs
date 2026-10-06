import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';

const output = resolve('docs/process/p4-4-screens');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p4-4-screens.opencrane.test';
const widths = [1280, 390, 320];
const frames = ['THR-05', 'THR-10', 'THR-11', 'THR-16'];
const transcriptVisibleCheck = "document.querySelector('.message-content')?.textContent?.includes('Tuesday') ?? false";
const noOverflowCheck = 'document.documentElement.scrollWidth <= window.innerWidth';
const focusedTagCheck = 'document.activeElement?.tagName';
const undersizedTargetsCheck = `Array.from(document.querySelectorAll(
  'main button, main a, main input, main textarea'
)).filter((target) => {
  const bounds = target.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0
    && (Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44);
}).map((target) => target.textContent?.trim() || target.tagName)`;
const captures = [];
const requestCounts = { turns: 0, models: 0, directCreates: 0, directMessages: 0 };
const people = [
  { memberId: 'grace-achieng', displayName: 'Grace Achieng' },
  { memberId: 'sales-person', displayName: 'Sales person' },
];
const initialRows = [
  messageRow(1, 'grace-achieng', 'Is the Tuesday slot still open?', '2026-10-06T09:20:00Z'),
  messageRow(2, 'alex-kim', 'Yes — I will confirm by noon.', '2026-10-06T09:21:00Z'),
];
let hideAccess = false;
let loseNextMessageReply = false;

function messageRow(position, authorId, text, time) {
  return { id: `message-${position}`, position, type: 'message.posted', time,
    data: { conversationId: 'direct-chat', authorId, authorKind: 'human', text,
      contentType: 'text' } };
}

async function serveAssets(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.startsWith('/api/')) {
    await serveApi(route, pathname);
    return;
  }
  await serveWebBuild(route, build);
}

async function serveApi(route, pathname) {
  const request = route.request();
  if (/turn|model|agent/i.test(pathname)) {
    if (pathname.includes('turn')) requestCounts.turns += 1;
    else requestCounts.models += 1;
    await route.fulfill({ status: 500, json: { status: 'unexpected' } });
    return;
  }
  if (request.method() === 'GET' && pathname === '/api/chat') {
    await route.fulfill({ json: { memberId: 'alex-kim', displayName: 'Alex Kim',
      assistantId: 'assistant-not-used' } });
    return;
  }
  if (request.method() === 'GET' && pathname === '/api/chat/colleagues') {
    await route.fulfill({ json: { rows: people, next: null } });
    return;
  }
  if (request.method() === 'GET' && pathname === '/api/conversations') {
    if (hideAccess) {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    await route.fulfill({ json: { rows: [{ conversationId: 'direct-chat',
      createdBy: 'alex-kim', createdAt: '2026-10-06T09:00:00Z', mode: 'direct',
      participantIds: ['alex-kim', 'grace-achieng'], status: 'open' }] } });
    return;
  }
  if (request.method() === 'GET' && pathname.endsWith('/messages')) {
    if (hideAccess) {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    await route.fulfill({ json: { rows: initialRows, position: 2, generation: 1,
      computerState: 'not_applicable' } });
    return;
  }
  if (request.method() === 'POST' && pathname === '/api/conversations') {
    requestCounts.directCreates += 1;
    await route.fulfill({ json: { status: 'appended', sequence: 1 } });
    return;
  }
  if (request.method() === 'POST' && pathname.endsWith('/messages')) {
    requestCounts.directMessages += 1;
    if (loseNextMessageReply) {
      loseNextMessageReply = false;
      await route.abort();
      return;
    }
    await route.fulfill({ json: { status: 'appended', sequence: 3 } });
    return;
  }
  if (pathname.includes('/changes/')) {
    const changeId = pathname.split('/').at(-1);
    await route.fulfill({ json: { status: 'appended', conversationId: 'direct-chat',
      commandId: changeId, type: 'message.posted', sequence: 3,
      projection: { content: 'current', iam: 'current' } } });
    return;
  }
  await route.fulfill({ status: 404, json: { status: 'not_found' } });
}

async function openPage(browser, width, reducedMotion, requestedState) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await page.route('**/*', serveAssets);
  await page.routeWebSocket('**/ws', attachConversationFeed);
  const response = await page.goto(`${origin}/workspace/direct`);
  assert.equal(response?.status(), 200, 'the direct chat route should load');
  await page.getByLabel('Search colleagues').waitFor();
  await page.locator('.colleague-option').filter({ hasText: 'Grace Achieng' }).click();
  if (requestedState !== 'THR-05') {
    if (width <= 700) {
      await page.getByRole('button', { name: 'Open direct conversations' }).click();
    }
    await page.getByRole('button', { name: 'Grace Achieng', exact: true }).last().click();
    await page.waitForFunction(transcriptVisibleCheck);
  }
  if (requestedState === 'THR-10') {
    await page.reload();
    await page.waitForFunction(transcriptVisibleCheck);
    assert.equal(await page.locator('.message').count(), 2,
      'reloading history must show each stored message once');
  }
  return page;
}

function attachConversationFeed(socket) {
  socket.onMessage(sendExistingRows.bind(null, socket));
}

function sendExistingRows(socket, raw) {
  const request = JSON.parse(String(raw));
  const missedRows = initialRows.filter((row) => row.position > request.since);
  for (const row of missedRows) {
    socket.send(JSON.stringify({ version: 1, topic: 'conversation',
      conversationId: request.conversationId, type: 'event', position: row.position,
      generation: 1, row }));
  }
  socket.send(JSON.stringify({ version: 1, topic: 'conversation',
    conversationId: request.conversationId, type: 'ready', position: 2, generation: 1,
    computerState: 'not_applicable' }));
}

async function captureState(browser, frame, width, reducedMotion) {
  hideAccess = false;
  loseNextMessageReply = false;
  const page = await openPage(browser, width, reducedMotion, frame);
  if (frame === 'THR-11') {
    loseNextMessageReply = true;
    await page.getByRole('textbox', { name: 'Message' }).fill('Also, can you share the PDF?');
    await page.getByLabel('Send message').click();
    await page.getByRole('status').getByText(/couldn't tell whether the message was recorded/)
      .waitFor();
  }
  if (frame === 'THR-16') {
    hideAccess = true;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByText('You no longer have access').waitFor();
    assert.equal(await page.locator('.message-content').count(), 0,
      'revoked access must clear transcript messages');
    assert.equal(await page.locator('textarea').count(), 0,
      'revoked access must remove the message editor');
  }
  assert.equal(await page.evaluate(noOverflowCheck), true,
    `${frame} must not scroll sideways at ${width}px`);
  assert.equal(await page.locator('[role="status"][aria-live="polite"]').count(), 1,
    'each page has one live status region');
  if (frame === 'THR-05') {
    await page.waitForFunction(`${focusedTagCheck} === 'TEXTAREA'`);
    assert.equal(await page.evaluate(focusedTagCheck), 'TEXTAREA',
      'selecting a colleague moves focus to the composer');
  }
  if (width < 700) {
    assert.deepEqual(await page.evaluate(undersizedTargetsCheck), [],
      `${frame} touch targets must be at least 44px at ${width}px`);
  }
  const name = `${frame.toLowerCase()}-${width}-${reducedMotion ? 'reduced' : 'normal'}.png`;
  await page.screenshot({ path: resolve(output, name), fullPage: true });
  captures.push({ frame, width, reducedMotion, file: name });
  await page.close();
}

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of widths) {
      for (const reducedMotion of [false, true]) {
        for (const frame of frames) {
          await captureState(browser, frame, width, reducedMotion);
        }
      }
    }
  } finally {
    await browser.close();
  }
  assert.equal(requestCounts.turns, 0, 'direct messages must not request turns');
  assert.equal(requestCounts.models, 0, 'direct messages must not request models');
  const receipt = {
    date: new Date().toISOString(),
    result: 'PASS',
    note: 'Sample browser data only; this does not qualify a fresh installation.',
    captures,
    requestCounts,
  };
  await writeFile(resolve(output, 'visual.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`PASS ${captures.length} screenshots; no turn or model requests\n`);
}

await main();
