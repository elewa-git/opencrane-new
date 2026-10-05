/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { APIResponse, Page } from 'playwright';
import { auditResponseSchema, chatFeedSchema } from '@opencrane/protocol';
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
      assert.equal(response.status(), 200);
      const history = auditResponseSchema.parse(await response.json());
      const row = history.rows.find(row => row.turnId === turn.id && row.decision === 'allow' && row.outcome === 'success');
      if (row) {
        assert.equal(row.requesterId, requesterId);
        assert.equal(row.conversationId, conversation);
        assert(row.contextDigest && row.permitId && row.requestId);
        assert(Number.isSafeInteger(row.reservedCents) && Number.isSafeInteger(row.settledCents));
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
    await page.goto(`${origin}/history/${conversation}`);
    await page.getByLabel('Turn id filter').fill(turn.id);
    await page.getByRole('button', { name: 'Apply filters', exact: true }).press('Enter');
    try {
      await page.getByText('Decision: allow', { exact: true }).first().waitFor();
    } catch (error) {
      await captureHistoryFailure(page, error);
    }
    await page.getByText('Observed outcome: Success', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Apply filters', exact: true }).evaluate(button => button === document.activeElement));
    await capture(page, `${output}/${run}-action-${page.viewportSize()!.width}.png`);
    console.log(`PASS ${run} audit ${page.viewportSize()!.width}px: own stub turn, allow and success shown separately; other member and owner refused private history`);
  }
  const response = await owner.request.get(`${origin}/api/org/history`);
  assert.equal(response.status(), 200);
  const changes = auditResponseSchema.parse(await response.json());
  assert(changes.rows.some(row => row.records.some(record => record.type === 'mcp.server_published')));
  assert(!JSON.stringify(changes).includes('canary'));
  assert.equal((await members[0]!.request.get(`${origin}/api/org/history`)).status(), 403);
  for (const width of [1280, 390]) {
    await owner.setViewportSize({ width, height: 900 });
    await owner.goto(`${origin}/org/history`);
    await owner.getByRole('heading', { name: 'Change history', exact: true }).waitFor();
    await owner.getByText('mcp.server_published', { exact: true }).first().waitFor();
    await capture(owner, `${output}/${run}-change-${width}.png`);
    await members[0]!.setViewportSize({ width, height: 900 });
    await members[0]!.goto(`${origin}/org/history`);
    await members[0]!.getByText('Access changed', { exact: true }).waitFor();
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

async function captureHistoryFailure(page: Page, error: unknown): Promise<never> {
  const width = page.viewportSize()?.width ?? 0;
  const results = page.locator('oc-audit .history > div[aria-busy]');
  const accessibleResults = await results.ariaSnapshot();
  await page.screenshot({ path: `${directory}/history-failure.png`, fullPage: true });
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    `${message}\nHistory page width: ${width}px\nAccessible history results:\n${accessibleResults}`,
  );
}

async function capture(page: Page, path: string) {
  assert(!(await page.locator('body').innerText()).includes('canary'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const controls = page.locator('oc-audit button, oc-audit input, oc-audit select');
  for (const control of await controls.all()) assert((await control.boundingBox())!.height >= 44);
  await page.screenshot({ path, fullPage: true });
}
