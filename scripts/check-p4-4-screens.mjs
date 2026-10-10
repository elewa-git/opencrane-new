import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';

const output = resolve('docs/process/p4-4-screens');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p4-4-screens.opencrane.test';
const widths = [1280, 390, 320];
const missingLinkOnly = process.argv.includes('--missing-link-only');
const frames = [
  'THR-05', 'THR-10', 'THR-11', 'THR-16', 'directory', 'no-match',
  'directory-loading', 'first-load-failed', 'refresh-failed', 'sending', 'send-failed',
  'missing-link',
  'lost-create', 'access-applying', 'missing-message', 'missing-create', 'literal-agent',
  'long-chat', 'waiting-access',
  'permissions-ready',
];
const transcriptVisibleCheck = "document.querySelector('.message-content')?.textContent?.includes('Tuesday') ?? false";
function clippedControls() {
  const clipped = [];
  const targets = globalThis.document.querySelectorAll('main button, main a, main input, main textarea');
  for (const target of targets) {
    const bounds = target.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    if (bounds.left < -1 || bounds.right > globalThis.window.innerWidth + 1) {
      clipped.push(target.textContent?.trim() || target.tagName);
    }
  }
  for (const area of globalThis.document.querySelectorAll('html, body, .main, .transcript')) {
    if (area.scrollLeft > 0) clipped.push(`${area.className || area.tagName} scrolled sideways`);
  }
  if (globalThis.document.documentElement.scrollWidth > globalThis.window.innerWidth) clipped.push('Page overflow');
  return clipped;
}
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
let loseNextCreateReply = false;
let failFirstLoad = false;
let failList = false;
let failSend = false;
let holdSearch = false;
let holdSend = false;
let applyingAccess = false;
let missingStatus = false;
let storedRows = [...initialRows];
const heldRoutes = [];

function matchesSearch(person, query) {
  return person.displayName.toLowerCase().includes(query.toLowerCase());
}

function messageRow(position, authorId, text, time) {
  return { id: `message-${position}`, position, type: 'message.posted', time,
    data: { conversationId: 'direct-chat', authorId, authorKind: 'human', text,
      contentType: 'text' } };
}

async function serveAssets(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
    await serveApi(route, pathname);
    return;
  }
  await serveWebBuild(route, build);
}

async function serveApi(route, pathname) {
  const request = route.request();
  if (request.method() === 'POST' && pathname === '/v1/responses') {
    requestCounts.models += 1;
    assert.fail('A direct chat must not request a model');
  }
  if (request.method() === 'POST') {
    const body = request.postDataJSON();
    if (pathname.endsWith('/messages') && ('executionMode' in body || 'stopTurnId' in body)) {
      requestCounts.turns += 1;
    }
    if (pathname === '/api/conversations') {
      assert.deepEqual(Object.keys(body).sort(), ['colleagueId', 'conversationId', 'id', 'mode']);
      assert.equal(body.mode, 'direct');
    } else {
      assert.deepEqual(Object.keys(body).sort(), ['id', 'text']);
    }
  }
  if (request.method() === 'GET' && pathname === '/api/chat') {
    if (failFirstLoad) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    await route.fulfill({ json: { memberId: 'alex-kim', displayName: 'Alex Kim',
      assistantId: 'assistant-not-used' } });
    return;
  }
  if (request.method() === 'GET' && pathname === '/api/chat/colleagues') {
    if (holdSearch) {
      heldRoutes.push(route);
      return;
    }
    const query = new URL(request.url()).searchParams.get('q') ?? '';
    function matchesQuery(person) { return matchesSearch(person, query); }
    const rows = people.filter(matchesQuery);
    await route.fulfill({ json: { rows, next: null } });
    return;
  }
  if (request.method() === 'GET' && pathname === '/api/conversations') {
    if (failList) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
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
    if (applyingAccess) {
      await route.fulfill({ status: 425, json: { status: 'access_applying' } });
      return;
    }
    if (hideAccess) {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    await route.fulfill({ json: { rows: storedRows, position: storedRows.length, generation: 1,
      computerState: 'not_applicable' } });
    return;
  }
  if (request.method() === 'POST' && pathname === '/api/conversations') {
    requestCounts.directCreates += 1;
    if (loseNextCreateReply) {
      loseNextCreateReply = false;
      await route.abort();
      return;
    }
    await route.fulfill({ json: { status: 'appended', sequence: 1 } });
    return;
  }
  if (request.method() === 'POST' && pathname.endsWith('/messages')) {
    requestCounts.directMessages += 1;
    if (holdSend) {
      heldRoutes.push(route);
      return;
    }
    if (failSend) {
      await route.fulfill({ status: 400, json: { status: 'refused' } });
      return;
    }
    if (loseNextMessageReply) {
      loseNextMessageReply = false;
      await route.abort();
      return;
    }
    const body = request.postDataJSON();
    const row = messageRow(storedRows.length + 1, 'alex-kim', body.text, '2026-10-06T09:22:00Z');
    row.id = body.id;
    storedRows.push(row);
    await route.fulfill({ json: { status: 'appended', sequence: storedRows.length + 1 } });
    return;
  }
  if (pathname.includes('/changes/')) {
    if (missingStatus) {
      const status = missingStatus === 'create' ? 403 : 404;
      await route.fulfill({ status, json: { status: 'not_found' } });
      return;
    }
    const changeId = pathname.split('/').at(-1);
    await route.fulfill({ json: { status: 'appended', conversationId: 'direct-chat',
      commandId: changeId, type: 'message.posted', sequence: 3,
      projection: { content: 'current', iam: 'current' } } });
    return;
  }
  assert.fail(`Unexpected direct chat API path: ${pathname}`);
}

async function openPage(browser, width, reducedMotion, requestedState) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await page.route('**/*', serveAssets);
  await page.routeWebSocket('**/ws', attachConversationFeed);
  const address = requestedState === 'missing-link'
    ? `${origin}/workspace/direct?conversation=removed-group`
    : `${origin}/workspace/direct`;
  const response = await page.goto(address);
  assert.equal(response?.status(), 200, 'the direct chat route should load');
  if (requestedState === 'missing-link') {
    await page.getByText('Conversation not found or unavailable').waitFor();
    if (width <= 700) {
      await page.getByRole('button', { name: 'Open direct conversations' }).click();
    }
    await page.getByRole('button', { name: 'Grace Achieng', exact: true }).waitFor();
    assert.equal(await page.locator('.conversation-row:visible').count(), 1,
      'the available conversation can be opened from the missing-link state');
    if (width <= 700) {
      await page.getByRole('button', { name: 'Close navigation' }).click();
    }
    return page;
  }
  if (requestedState === 'first-load-failed') {
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    return page;
  }
  await page.getByLabel('Search colleagues').waitFor();
  if (['directory', 'no-match', 'directory-loading'].includes(requestedState)) return page;
  await page.locator('.colleague-option').filter({ hasText: 'Grace Achieng' }).click();
  if (!['THR-05', 'lost-create', 'missing-create', 'access-applying', 'waiting-access',
    'permissions-ready'].includes(requestedState)) {
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
  assert.equal(request.type, 'subscribe', 'Direct chat sockets only subscribe');
  function afterCursor(row) { return row.position > request.since; }
  const missedRows = storedRows.filter(afterCursor);
  for (const row of missedRows) {
    socket.send(JSON.stringify({ version: 1, topic: 'conversation',
      conversationId: request.conversationId, type: 'event', position: row.position,
      generation: 1, row }));
  }
  socket.send(JSON.stringify({ version: 1, topic: 'conversation',
    conversationId: request.conversationId, type: 'ready', position: storedRows.length, generation: 1,
    computerState: 'not_applicable' }));
}

async function captureState(browser, frame, width, reducedMotion) {
  hideAccess = false;
  loseNextMessageReply = false;
  loseNextCreateReply = false;
  failFirstLoad = frame === 'first-load-failed';
  failList = false;
  failSend = false;
  holdSearch = false;
  holdSend = false;
  applyingAccess = false;
  missingStatus = false;
  storedRows = [...initialRows];
  if (frame === 'long-chat') {
    storedRows = [];
    for (let position = 1; position <= 40; position++) {
      const text = `Tuesday message ${position}`;
      storedRows.push(messageRow(position, 'grace-achieng', text, '2026-10-06T09:20:00Z'));
    }
  }
  const page = await openPage(browser, width, reducedMotion, frame);
  if (frame === 'missing-link') {
    assert.equal(await page.getByText('You no longer have access').count(), 0,
      'a missing link must not look like revoked access');
  }
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
  await prepareExtraState(page, frame);
  assert.deepEqual(await page.evaluate(clippedControls), [],
    `${frame} controls must fit at ${width}px`);
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
  await releaseHeldRoutes();
  await page.close();
}

async function prepareExtraState(page, frame) {
  if (frame === 'no-match') {
    await page.getByLabel('Search colleagues').fill('Nobody here');
    await page.getByText('No colleagues match this search.').waitFor();
  }
  if (frame === 'directory-loading') {
    holdSearch = true;
    await page.getByLabel('Search colleagues').fill('Grace');
    await page.getByText('Loading colleagues…', { exact: true }).waitFor();
  }
  if (frame === 'refresh-failed') {
    failList = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('.refresh-error').waitFor();
  }
  if (['sending', 'send-failed', 'lost-create', 'missing-create', 'access-applying',
    'missing-message', 'literal-agent', 'waiting-access', 'permissions-ready'].includes(frame)) {
    holdSend = frame === 'sending';
    failSend = frame === 'send-failed';
    loseNextCreateReply = ['lost-create', 'missing-create'].includes(frame);
    loseNextMessageReply = frame === 'missing-message';
    applyingAccess = ['access-applying', 'waiting-access', 'permissions-ready'].includes(frame);
    const text = frame === 'literal-agent' ? '@agent is ordinary human text here.' : 'Keep this message.';
    await page.getByRole('textbox', { name: 'Message' }).fill(text);
    await page.getByLabel('Send message').click();
    if (frame === 'sending') await page.locator('.send-feedback').getByText('Sending message…').waitFor();
    if (frame === 'send-failed') await page.locator('.send-feedback').getByText('The message could not be accepted.').waitFor();
    if (frame === 'access-applying') {
      await page.locator('.send-feedback').getByText('Starting the conversation…').waitFor();
    }
    if (['lost-create', 'missing-create', 'missing-message'].includes(frame)) {
      await page.getByRole('button', { name: 'Check status' }).waitFor();
    }
    if (frame === 'missing-message' || frame === 'missing-create') {
      missingStatus = frame === 'missing-create' ? 'create' : 'message';
      await page.getByRole('button', { name: 'Check status' }).click();
      const retryName = frame === 'missing-create' ? 'Try again' : 'Send again';
      await page.getByRole('button', { name: retryName, exact: true }).waitFor();
    }
    if (frame === 'waiting-access' || frame === 'permissions-ready') {
      await page.locator('.send-feedback').getByText(/Permissions are still being applied/).waitFor();
    }
    if (frame === 'permissions-ready') {
      applyingAccess = false;
      const postsBefore = requestCounts.directMessages;
      await page.getByRole('button', { name: 'Check status' }).click();
      await page.getByRole('button', { name: 'Send again', exact: true }).waitFor();
      assert.equal(requestCounts.directMessages, postsBefore, 'Checking permissions only reads');
    }
    if (frame === 'literal-agent') await page.locator('.message-content').getByText(text).waitFor();
  }
  await page.evaluate(waitForStableLayout);
  if (frame === 'long-chat') {
    await page.waitForFunction(transcriptAtEnd);
    assert.equal(await page.locator('article.message').count(), 40);
  }
  assert.equal(await page.locator('#attach-toggle').count(), 0, 'Hide assistant attachment controls');
}

async function waitForStableLayout() {
  await globalThis.document.fonts.ready;
  const finished = [];
  for (const animation of globalThis.document.getAnimations()) {
    const timing = animation.effect?.getTiming();
    if (timing?.iterations !== Infinity) finished.push(animation.finished);
  }
  await Promise.allSettled(finished);
}

function transcriptAtEnd() {
  const transcript = globalThis.document.querySelector('.transcript');
  if (!transcript) return false;
  const remaining = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  return remaining < 2;
}

async function releaseHeldRoutes() {
  while (heldRoutes.length) {
    const route = heldRoutes.shift();
    await route.fulfill({ status: 503, json: { status: 'unavailable' } });
  }
}

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const captureWidths = widths;
    const captureFrames = missingLinkOnly ? ['missing-link'] : frames;
    for (const width of captureWidths) {
      for (const reducedMotion of [false, true]) {
        for (const frame of captureFrames) {
          await captureState(browser, frame, width, reducedMotion);
        }
      }
    }
  } finally {
    await browser.close();
  }
  assert.equal(requestCounts.turns, 0, 'direct messages must not request turns');
  assert.equal(requestCounts.models, 0, 'direct messages must not request models');
  if (!missingLinkOnly) {
    const receipt = {
      date: new Date().toISOString(),
      result: 'PASS',
      note: 'Sample browser data only; this does not qualify a fresh installation.',
      captures,
      requestCounts,
    };
    await writeFile(resolve(output, 'visual.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  process.stdout.write(`PASS ${captures.length} screenshots; no turn or model requests\n`);
}

await main();
