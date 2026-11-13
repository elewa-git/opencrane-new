/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { APIResponse, Page, Request, Response } from 'playwright';
import { auditResponseSchema, chatFeedSchema, type AuditRow } from '@opencrane/protocol';
import { directory, root } from './config.ts';
import { project } from './identity.ts';

export const auditPrompt = 'Say hello briefly. p3-19-private-text-canary';

/** Read real stub-turn evidence and check privacy on the running secondary stack. */
export async function browserAuditJourney(owner: Page, members: Page[], origin: string, requesterId: string,
  otherCookie: string, run: 'fresh' | 'repeat') {
  const output = `${root}/docs/process/p3-19-live`;
  const workspaces = members.map(page => ({ page, url: page.url(), viewport: page.viewportSize()! }));
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) await copyFile(`${directory}/workspace-${width}.png`, `${output}/${run}-stub-chat-${width}.png`);
  for (const page of members) {
    const conversation = new URL(page.url()).searchParams.get('conversation');
    assert(conversation);
    const path = `/api/conversations/${conversation}/history`;
    const messages = await page.request.get(`${origin}/api/conversations/${conversation}/messages`);
    assert.equal(messages.status(), 200);
    const feed = chatFeedSchema.parse(await messages.json());
    const turn = feed.rows.find(row => row.type === 'message.posted' && row.data['text'] === auditPrompt);
    assert(turn, 'The member posted the privacy canary through the real chat');
    const deadline = Date.now() + 90_000;
    for (;;) {
      const response: APIResponse = await page.request.get(`${origin}${path}?turnId=${turn.id}`);
      if (response.status() === 503) {
        // Wait for the audit history to catch up with the saved turn decision.
        assert(Date.now() < deadline, 'Audit history is available after the saved turn');
        await delay(100);
        continue;
      }
      assert.equal(response.status(), 200);
      const history = auditResponseSchema.parse(await response.json());
      const row = history.rows.find(row => row.turnId === turn.id && row.decision === 'allow' && row.outcome === 'success');
      if (row) {
        assert.equal(row.requesterId, requesterId);
        assert.equal(row.conversationId, conversation);
        assert(row.contextDigest && row.permitId && row.requestId);
        assert(!('reservedCents' in row) && !('settledCents' in row),
          'Member action history does not expose money amounts');
        await assertAuditMoney(owner, origin, row);
        assert(!JSON.stringify(history).includes('canary'));
        break;
      }
      assert(Date.now() < deadline, 'Stub turn has a recorded decision and observed success');
      await delay(100);
    }
    assert.equal((await fetch(`${origin}${path}`, { headers: { cookie: otherCookie } })).status, 403,
      'Another joined member cannot read this private action history');
    assert.equal((await owner.request.get(`${origin}${path}`)).status(), 403,
      'The owner role does not grant access to private action history');
    await checkActionHistory(page, `${origin}/history/${conversation}`);
    await capture(page, `${output}/${run}-action-${page.viewportSize()!.width}.png`);
    console.log(`PASS ${run} audit ${page.viewportSize()!.width}px: own stub turn, allow and success shown separately; other member and owner refused private history`);
  }
  const publication = await assertPublishedAudit(owner, origin);
  assert.equal((await members[0]!.request.get(`${origin}/api/org/history`)).status(), 403);
  for (const width of [1280, 390]) {
    await owner.setViewportSize({ width, height: 900 });
    await owner.goto(`${origin}/org/history`);
    await owner.getByRole('heading', { name: 'Change history', exact: true }).waitFor();
    await checkChangeHistory(owner, publication, `${output}/${run}-category-${width}.png`);
    await capture(owner, `${output}/${run}-change-${width}.png`);
    await members[0]!.setViewportSize({ width, height: 900 });
    await members[0]!.goto(`${origin}/org/history`);
    await members[0]!.getByText('Access changed. Protected history has been cleared.', { exact: true }).waitFor();
    assert.equal(await members[0]!.locator('oc-audit article').count(), 0);
    await capture(members[0]!, `${output}/${run}-refused-${width}.png`);
  }
  const canaries = ['p3-19-private-text-canary', 'p3-19-query-canary', 'p3-19-conversation-canary', 'p3-19-bearer-canary'];
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    await fetch(`${origin}/api/conversations/p3-19-conversation-canary/history/?requestId=p3-19-query-canary`, {
      method, headers: { authorization: 'Bearer p3-19-bearer-canary' },
    });
  }
  await delay(200);
  assert((await readFile(`${directory}/server.log`, 'utf8')).includes('/api/org/history'), 'The live server logs audit requests');
  const logs = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.log')).map(name => readFile(`${directory}/${name}`, 'utf8')));
  logs.push(await readFile(`${directory}/models/usage.jsonl`, 'utf8'));
  const models = await promisify(execFile)('docker', ['logs', `${project}-models-1`], { maxBuffer: 8 * 1024 * 1024 });
  for (const canary of canaries) assert(![...logs, models.stdout, models.stderr].some(log => log.includes(canary)), 'Live logs exclude private text, filter, conversation and bearer canaries');
  console.log(`PASS ${run} audit: owner organisation metadata without private text; member organisation history refused; live process and model/gateway log canaries absent`);
  for (const { page, url, viewport } of workspaces) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
  }
}

export async function assertAuditMoney(owner: Pick<Page, 'request'>, origin: string, memberRow: AuditRow) {
  assert(memberRow.requestId && memberRow.permitId);
  const query = new URLSearchParams({ requestId: memberRow.requestId });
  const response = await owner.request.get(`${origin}/api/org/history?${query}`);
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
  assert(Number.isSafeInteger(row.reservedCents) && Number.isSafeInteger(row.settledCents),
    'Admin Change history keeps integer reserved and settled euro cents');
  assert(!JSON.stringify(changes).includes('canary'));
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
    const response = await owner.request.get(`${origin}/api/org/history${query}`);
    assert.equal(response.status(), 200);
    const changes = auditResponseSchema.parse(await response.json());
    assert(!JSON.stringify(changes).includes('canary'));
    const publication = changes.rows.find(hasPublication);
    if (publication) return publication;
    if (changes.nextBefore === undefined) break;
    assert(before === undefined || changes.nextBefore < before,
      'Older change history moves towards earlier events');
    before = changes.nextBefore;
  }
  assert.fail('Organisation history contains the saved MCP publication');
}

async function checkChangeHistory(page: Page, publication: AuditRow, screenshot: string) {
  await page.getByText('History loaded', { exact: true }).waitFor();
  while (await page.locator('oc-audit article .family-icon').filter({ hasText: '👤' }).count() === 0) {
    const older = page.getByRole('button', { name: 'Older history', exact: true });
    assert(await older.count(), 'An older page shows a member change');
    const previousCount = await page.locator('oc-audit article').count();
    await older.focus();
    await older.press('Enter');
    await page.locator('oc-audit article').nth(previousCount).waitFor();
  }
  assert(await page.locator('oc-audit article .family-icon').filter({ hasText: '👤' }).count() > 0,
    'The unfiltered screen shows a member change');
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
  const categoryHistory = auditResponseSchema.parse(await categoryReply.json());
  assert(categoryHistory.rows.length > 0, 'The tools category contains saved changes');
  for (const row of categoryHistory.rows) {
    assert(/^(tool|mcp|connection|egress|credential|provider|model)\./u
      .test(row.records[0]?.type ?? ''), 'Every listed change belongs to Tools & models');
  }
  await page.getByText('History loaded', { exact: true }).waitFor();
  assert.equal(await page.locator('oc-audit article').count(), categoryHistory.rows.length);
  assert.equal(await page.locator('oc-audit article .family-icon').filter({ hasText: '👤' }).count(), 0,
    'The Tools & models screen excludes member changes');
  assert(await category.evaluate(isFocused), 'Keyboard selection keeps focus on the category');
  await capture(page, screenshot);
  const visibleRows = [...categoryHistory.rows];
  while (!visibleRows.some(row => row.id === publication.id)) {
    const older = page.getByRole('button', { name: 'Older history', exact: true });
    assert(await older.count(), 'The publication is on an older Tools & models page');
    function olderResponse(response: Response) {
      const url = new URL(response.url());
      return url.pathname === '/api/org/history' && url.searchParams.get('family') === 'tools'
        && url.searchParams.has('before');
    }
    const olderLoaded = page.waitForResponse(olderResponse);
    await older.focus();
    await older.press('Enter');
    const olderReply = await olderLoaded;
    assert.equal(olderReply.status(), 200);
    const olderHistory = auditResponseSchema.parse(await olderReply.json());
    assert(olderHistory.rows.length > 0, 'An older page contains saved changes');
    visibleRows.push(...olderHistory.rows);
    await page.locator('oc-audit article').nth(visibleRows.length - 1).waitFor();
    assert.equal(await page.locator('oc-audit article').count(), visibleRows.length);
  }
  const publicationIndex = visibleRows.findIndex(row => row.id === publication.id);
  const entry = page.locator('oc-audit article .row-button').nth(publicationIndex);
  const visibleTitle = await entry.locator('strong').innerText();
  assert.equal(visibleTitle.replace(/\s+/gu, ' ').trim(), '• Organisation change',
    'The publication has the title shown on the shipped screen');
  const visibleSummary = await entry.locator('small').innerText();
  assert.equal(visibleSummary.replace(/\s+/gu, ' ').trim(),
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
  );
}

async function capture(page: Page, path: string) {
  assert(!(await page.locator('body').innerText()).includes('canary'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const controls = page.locator('oc-audit button, oc-audit input, oc-audit select');
  for (const control of await controls.all()) assert((await control.boundingBox())!.height >= 44);
  await page.screenshot({ path, fullPage: true });
}

type HistoryRead = { status?: number; error?: string };

async function checkActionHistory(page: Page, url: string) {
  const reads: HistoryRead[] = [];
  function recordResponse(response: Response) {
    if (new URL(response.url()).pathname.endsWith('/history')) {
      reads.push({ status: response.status() });
    }
  }
  function recordFailure(request: Request) {
    if (!new URL(request.url()).pathname.endsWith('/history')) return;
    const error = request.failure()?.errorText ?? '';
    const code = /^net::[A-Z_]+$/u.test(error) ? error : 'transport_failed';
    reads.push({ error: code });
  }
  page.on('response', recordResponse);
  page.on('requestfailed', recordFailure);
  try {
    await page.goto(url);
    await page.getByText(/Decision: allow\s*· Observation: Confirmed/u).first().waitFor();
  } catch (error) {
    await captureHistoryFailure(page, error, reads);
  } finally {
    page.off('response', recordResponse);
    page.off('requestfailed', recordFailure);
  }
}
