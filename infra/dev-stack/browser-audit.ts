/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page, Request, Response, ViewportSize } from 'playwright';
import { auditResponseSchema, chatFeedSchema, type AuditRow } from '@opencrane/protocol';
import { readJourneyApi } from './browser-api.ts';
import { directory, root } from './config.ts';
import { project } from './identity.ts';

export const auditPrompt = 'Say hello briefly. p3-19-private-text-canary';

export type AuditJourneyAccess = { requesterId: string; otherCookie: string };

/** Check saved test-model calls and privacy on the running spare stack. */
export async function browserAuditJourney(owner: Page, members: Page[], origin: string,
  access: AuditJourneyAccess, run: 'fresh' | 'repeat') {
  const { requesterId, otherCookie } = access;
  const output = `${root}/docs/process/p3-19-live`;
  const workspaces = [];
  for (const page of members) {
    const workspace = { page, url: page.url(), viewport: page.viewportSize()! };
    workspaces.push(workspace);
  }
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    await copyFile(`${directory}/workspace-${width}.png`, `${output}/${run}-stub-chat-${width}.png`);
  }
  for (const page of members) {
    const { conversation, row, history } = await readSuccessfulTurnAudit(page, origin, auditPrompt);
    const address = `${origin}/api/conversations/${conversation}/history`;
    assert.equal(row.requesterId, requesterId);
    await assertAuditMoney(owner, origin, row);
    assert(!JSON.stringify(history).includes('canary'));
    const otherSession = { headers: { cookie: otherCookie } };
    const otherResponse = await fetch(address, otherSession);
    assert.equal(otherResponse.status, 403,
      'Another joined member cannot read this private action history');
    const ownerResponse = await readJourneyApi(owner, address);
    assert.equal(ownerResponse.status(), 403,
      'The owner role does not grant access to private action history');
    await checkActionHistory(page, `${origin}/history/${conversation}`);
    await capture(page, `${output}/${run}-action-${page.viewportSize()!.width}.png`);
    const width = page.viewportSize()!.width;
    console.log(`PASS ${run} audit ${width}px: own test-model turn; ` +
      'allow and success shown separately; other member and owner refused private history');
  }
  const publication = await assertPublishedAudit(owner, origin);
  const member = members[0]!;
  const memberHistory = await readJourneyApi(member, `${origin}/api/org/history`);
  assert.equal(memberHistory.status(), 403);
  for (const width of [1280, 390]) {
    const viewport = { width, height: 900 };
    await owner.setViewportSize(viewport);
    await openChangeHistory(owner, `${origin}/org/history`);
    await checkChangeHistory(owner, publication, `${output}/${run}-category-${width}.png`);
    await capture(owner, `${output}/${run}-change-${width}.png`);
    await member.setViewportSize(viewport);
    await member.goto(`${origin}/org/history`);
    const refusal = member.getByText('Access changed. Protected history has been cleared.', {
      exact: true,
    });
    await refusal.waitFor();
    assert.equal(await member.locator('oc-audit article').count(), 0);
    await capture(member, `${output}/${run}-refused-${width}.png`);
  }
  await checkAuditLogPrivacy(origin);
  console.log(`PASS ${run} audit: owner organisation metadata without private text; ` +
    'member organisation history refused; private markers absent from process and model logs');
  await restoreWorkspaces(workspaces);
}

async function checkAuditLogPrivacy(origin: string) {
  // Use synthetic private text, query, conversation path and bearer markers to test
  // log redaction without real private data. Keep all three HTTP methods below
  // to check that different request handling paths also hide these fields.
  const canaries = [
    'p3-19-private-text-canary',
    'p3-19-query-canary',
    'p3-19-conversation-canary',
    'p3-19-bearer-canary',
  ];
  const address = `${origin}/api/conversations/p3-19-conversation-canary/history/` +
    '?requestId=p3-19-query-canary';
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    const request = { method, headers: { authorization: 'Bearer p3-19-bearer-canary' } };
    await fetch(address, request);
  }
  await delay(200);
  const serverLog = await readFile(`${directory}/server.log`, 'utf8');
  assert(serverLog.includes('/api/org/history'), 'The live server logs audit requests');
  const files = await readdir(directory);
  const pendingLogs = [];
  for (const name of files) {
    if (name.endsWith('.log')) {
      pendingLogs.push(readFile(`${directory}/${name}`, 'utf8'));
    }
  }
  const logs = await Promise.all(pendingLogs);
  logs.push(await readFile(`${directory}/models/usage.jsonl`, 'utf8'));
  const execute = promisify(execFile);
  const processOptions = { maxBuffer: 8 * 1024 * 1024 };
  const models = await execute('docker', ['logs', `${project}-models-1`], processOptions);
  logs.push(models.stdout, models.stderr);
  for (const canary of canaries) {
    for (const log of logs) {
      assert(!log.includes(canary),
        'Live logs exclude private text, filter, conversation and bearer canaries');
    }
  }
}

type SavedWorkspace = { page: Page; url: string; viewport: ViewportSize };

async function restoreWorkspaces(workspaces: SavedWorkspace[]) {
  for (const { page, url, viewport } of workspaces) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
  }
}

export async function readSuccessfulTurnAudit(page: Pick<Page, 'request' | 'url'>, origin: string,
  prompt: string) {
  const location = new URL(page.url());
  const conversation = location.searchParams.get('conversation');
  assert(conversation, 'The member has a saved conversation');
  const path = `${origin}/api/conversations/${conversation}`;
  const messages = await readJourneyApi(page, `${path}/messages`);
  assert.equal(messages.status(), 200);
  const messageBody: unknown = await messages.json();
  const feed = chatFeedSchema.parse(messageBody);
  function matchesPrompt(row: typeof feed.rows[number]) {
    return row.type === 'message.posted' && row.data['text'] === prompt;
  }
  const turn = feed.rows.find(matchesPrompt);
  assert(turn, 'The member posted the expected message in chat');
  const turnId = turn.id;
  function successfulCall(row: AuditRow) {
    return row.turnId === turnId && row.decision === 'allow' && row.outcome === 'success';
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await readJourneyApi(page, `${path}/history?turnId=${turnId}`);
    if (response.status() !== 503) {
      assert.equal(response.status(), 200);
      const historyBody: unknown = await response.json();
      const history = auditResponseSchema.parse(historyBody);
      for (const entry of history.rows) {
        assert(!('reservedCents' in entry) && !('settledCents' in entry),
          'Member action history does not expose money amounts');
      }
      const row = history.rows.find(successfulCall);
      if (row) {
        assert.equal(row.conversationId, conversation);
        assert(row.contextDigest && row.permitId && row.requestId);
        return { conversation, row, history };
      }
    }
    await delay(100);
  }
  assert.fail('Chat turn has a recorded decision and observed success');
}

export async function assertAuditMoney(owner: Pick<Page, 'request'>, origin: string,
  memberRow: AuditRow) {
  assert(memberRow.requestId && memberRow.permitId);
  const query = new URLSearchParams({ requestId: memberRow.requestId });
  const response = await readJourneyApi(owner, `${origin}/api/org/history?${query}`);
  assert.equal(response.status(), 200);
  const changes = auditResponseSchema.parse(await response.json());
  function sameCall(row: AuditRow) {
    return row.requestId === memberRow.requestId && row.permitId === memberRow.permitId;
  }
  const row = changes.rows.find(sameCall);
  assert(row, 'Admin Change history contains the same call as member action history');
  assert.equal(row.requesterId, memberRow.requesterId);
  assert.equal(row.conversationId, memberRow.conversationId);
  assert.equal(row.turnId, memberRow.turnId);
  const { reservedCents, settledCents } = row;
  assert(reservedCents !== undefined && settledCents !== undefined,
    'Admin Change history keeps integer reserved and settled euro cents');
  assert(!JSON.stringify(changes).includes('canary'));
  return { auditId: row.id, reservedCents, chargedCents: settledCents };
}

export async function openTurnSpending(admin: Page, origin: string, auditId: string) {
  await openChangeHistory(admin, `${origin}/org/history`);
  const search = admin.getByRole('searchbox', { name: 'Safe reference', exact: true });
  await search.fill(auditId);
  function searched(response: Response): boolean {
    const url = new URL(response.url());
    return url.pathname === '/api/org/history' && url.searchParams.get('reference') === auditId;
  }
  const searchReply = admin.waitForResponse(searched);
  await search.press('Enter');
  const found = await searchReply;
  assert.equal(found.status(), 200);
  const loaded = admin.getByText('History loaded', { exact: true });
  await loaded.waitFor();
  const row = admin.locator('oc-audit article .row-button');
  const detailUrl = `${origin}/api/org/history/${encodeURIComponent(auditId)}`;
  const detailReply = admin.waitForResponse(detailUrl);
  await row.click();
  const reply = await detailReply;
  assert.equal(reply.status(), 200, 'Change history opens the matching call');
  const detail = admin.getByRole('dialog');
  return detail.locator('dl[aria-label="Turn spending"]');
}

export async function assertPublishedAudit(owner: Pick<Page, 'request'>, origin: string) {
  const deadline = Date.now() + 60_000;
  let before: number | undefined;
  function isPublication(record: { type: string }) {
    return record.type === 'mcp.server_published';
  }
  function hasPublication(row: { records: Array<{ type: string }> }) {
    return row.records.some(isPublication);
  }
  while (Date.now() < deadline) {
    const query = before === undefined ? '' : `?before=${before}`;
    const response = await readJourneyApi(owner, `${origin}/api/org/history${query}`);
    assert.equal(response.status(), 200);
    const body: unknown = await response.json();
    const changes = auditResponseSchema.parse(body);
    assert(!JSON.stringify(changes).includes('canary'));
    const publication = changes.rows.find(hasPublication);
    if (publication) {
      return publication;
    }
    if (changes.nextBefore === undefined) {
      break;
    }
    assert(before === undefined || changes.nextBefore < before,
      'Older change history moves towards earlier events');
    before = changes.nextBefore;
  }
  assert.fail('Organisation history contains the saved MCP publication');
}

async function checkChangeHistory(page: Page, publication: AuditRow, screenshot: string) {
  const familyIcons = page.locator('oc-audit article .family-icon');
  const memberIcons = familyIcons.filter({ hasText: '👤' });
  while (await memberIcons.count() === 0) {
    const older = page.getByRole('button', { name: 'Older history', exact: true });
    assert(await older.count(), 'An older page shows a member change');
    const previousCount = await page.locator('oc-audit article').count();
    await older.focus();
    await older.press('Enter');
    const articles = page.locator('oc-audit article');
    await articles.nth(previousCount).waitFor();
  }
  assert(await memberIcons.count() > 0,
    'The unfiltered screen shows a member change');
  const categoryHistory = await selectToolsCategory(page);
  await page.getByText('History loaded', { exact: true }).waitFor();
  assert.equal(await page.locator('oc-audit article').count(), categoryHistory.rows.length);
  assert.equal(await memberIcons.count(), 0,
    'The Tools & models screen excludes member changes');
  const category = page.getByRole('button', { name: 'Tools & models', exact: true });
  assert(await category.evaluate(isFocused), 'Keyboard selection keeps focus on the category');
  await capture(page, screenshot);
  const publicationIndex = await findPublishedChange(page, categoryHistory.rows, publication.id);
  await checkPublishedChange(page, publicationIndex);
}

async function selectToolsCategory(page: Page) {
  function categoryResponse(response: Response) {
    const url = new URL(response.url());
    return url.pathname === '/api/org/history' && url.searchParams.get('family') === 'tools'
      && !url.searchParams.has('reference');
  }
  const categoryLoaded = page.waitForResponse(categoryResponse);
  const category = page.getByRole('button', { name: 'Tools & models', exact: true });
  await category.focus();
  await category.press('Enter');
  const categoryReply = await categoryLoaded;
  assert.equal(categoryReply.status(), 200);
  const categoryBody: unknown = await categoryReply.json();
  const categoryHistory = auditResponseSchema.parse(categoryBody);
  assert(categoryHistory.rows.length > 0, 'The tools category contains saved changes');
  const toolEventPattern = /^(tool|mcp|connection|egress|credential|provider|model)\./u;
  for (const row of categoryHistory.rows) {
    const eventType = row.records[0]?.type ?? '';
    assert(toolEventPattern.test(eventType), 'Every listed change belongs to Tools & models');
  }
  return categoryHistory;
}

async function findPublishedChange(page: Page, initialRows: AuditRow[], publicationId: string) {
  const visibleRows = [...initialRows];
  function isPublication(row: AuditRow) {
    return row.id === publicationId;
  }
  function olderResponse(response: Response) {
    const url = new URL(response.url());
    return url.pathname === '/api/org/history' && url.searchParams.get('family') === 'tools'
      && url.searchParams.has('before');
  }
  while (!visibleRows.some(isPublication)) {
    const older = page.getByRole('button', { name: 'Older history', exact: true });
    assert(await older.count(), 'The publication is on an older Tools & models page');
    const olderLoaded = page.waitForResponse(olderResponse);
    await older.focus();
    await older.press('Enter');
    const olderReply = await olderLoaded;
    assert.equal(olderReply.status(), 200);
    const olderBody: unknown = await olderReply.json();
    const olderHistory = auditResponseSchema.parse(olderBody);
    assert(olderHistory.rows.length > 0, 'An older page contains saved changes');
    visibleRows.push(...olderHistory.rows);
    const articles = page.locator('oc-audit article');
    await articles.nth(visibleRows.length - 1).waitFor();
    assert.equal(await articles.count(), visibleRows.length);
  }
  return visibleRows.findIndex(isPublication);
}

async function checkPublishedChange(page: Page, publicationIndex: number) {
  const entries = page.locator('oc-audit article .row-button');
  const entry = entries.nth(publicationIndex);
  const visibleTitle = await entry.locator('strong').innerText();
  const singleLineTitle = visibleTitle.replace(/\s+/gu, ' ');
  assert.equal(singleLineTitle.trim(), '• Organisation change',
    'The publication has the title shown on the shipped screen');
  const visibleSummary = await entry.locator('small').innerText();
  const singleLineSummary = visibleSummary.replace(/\s+/gu, ' ');
  assert.equal(singleLineSummary.trim(),
    'Decision: Not recorded · Observation: Change recorded',
    'The publication has its visible decision and observation');
  await entry.focus();
  await entry.press('Enter');
  const detail = page.getByRole('dialog');
  await detail.getByRole('heading', { name: 'Organisation change', exact: true }).waitFor();
  assert(!(await detail.innerText()).includes('canary'), 'Admin detail contains safe metadata only');
  await page.keyboard.press('Escape');
  assert(await entry.evaluate(isFocused), 'Closing the detail restores keyboard focus');
}

function isFocused(element: Element) {
  return element === document.activeElement;
}

async function captureHistoryFailure(page: Page, error: unknown, reads: HistoryRead[]): Promise<never> {
  const width = page.viewportSize()?.width ?? 0;
  const results = page.locator('oc-audit .history-list');
  const accessibleResults = await results.ariaSnapshot();
  await page.screenshot({ path: `${directory}/history-failure.png`, fullPage: true });
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    `${message}\nHistory page width: ${width}px\nAccessible history results:\n${accessibleResults}\nHistory reads: ${JSON.stringify(reads)}`,
    { cause: error },
  );
}

async function capture(page: Page, path: string) {
  const body = page.locator('body');
  const text = await body.innerText();
  assert(!text.includes('canary'));
  assert(await page.evaluate(fitsViewport));
  const controls = page.locator('oc-audit button, oc-audit input, oc-audit select');
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    assert(box!.height >= 44);
  }
  const screenshot = { path, fullPage: true };
  await page.screenshot(screenshot);
}

function fitsViewport() {
  return document.documentElement.scrollWidth <= innerWidth;
}

type HistoryRead = { status?: number; error?: string };

async function openChangeHistory(page: Page, url: string) {
  const loaded = page.getByText('History loaded', { exact: true });
  await openHistory(page, url, loaded);
  await page.getByRole('heading', { name: 'Change history', exact: true }).waitFor();
}

async function checkActionHistory(page: Page, url: string) {
  const confirmed = page.getByText(/Decision: allow\s*· Observation: Confirmed/u);
  const loaded = confirmed.first();
  await openHistory(page, url, loaded);
}

async function openHistory(page: Page, url: string, loaded: Locator) {
  const reads: HistoryRead[] = [];
  function recordResponse(response: Response) {
    if (isHistoryRead(response.url())) {
      reads.push({ status: response.status() });
    }
  }
  function recordFailure(request: Request) {
    if (!isHistoryRead(request.url())) {
      return;
    }
    const error = request.failure()?.errorText ?? '';
    const code = /^net::[A-Z_]+$/u.test(error) ? error : 'transport_failed';
    reads.push({ error: code });
  }
  page.on('response', recordResponse);
  page.on('requestfailed', recordFailure);
  try {
    await page.goto(url);
    await loaded.waitFor();
  } catch (error) {
    await captureHistoryFailure(page, error, reads);
  } finally {
    page.off('response', recordResponse);
    page.off('requestfailed', recordFailure);
  }
}

function isHistoryRead(address: string): boolean {
  const path = new URL(address).pathname;
  return path.startsWith('/api/') && path.endsWith('/history');
}
