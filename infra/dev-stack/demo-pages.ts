import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { loadAuthConfig } from '@opencrane/auth';
import { demoStackId } from './demo-seed.ts';

async function capture(page: Page, output: string, name: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const mask = [page.locator('#invitation-link')];
    await page.screenshot({ path: `${output}/${name}-${width}.png`, mask });
  }
}

async function checkPages(page: Page, origin: string, output: string) {
  const results: Array<{ step: string; result: string; elapsedMs: number }> = [];
  async function actionHistory() {
    await page.goto(`${origin}/history/demo-supplier-v1`);
    await page.getByText('Decision: allow', { exact: true }).first().waitFor();
    await page.getByText('Observed outcome: Success', { exact: true }).first().waitFor();
    await capture(page, output, 'action-history');
  }
  async function groupAndInvite() {
    await page.goto(`${origin}/org/people/groups/demo-acacia`);
    await page.getByRole('heading', { name: 'Acacia Trading', exact: true }).waitFor();
    await capture(page, output, 'group');
    await page.goto(`${origin}/org/people`);
    await page.getByRole('button', { name: 'Invite people', exact: true }).click();
    await page.locator('#invite-email').fill('rehearsal@example.invalid');
    await page.locator('#invite-assistant').selectOption('none');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText('Link created. No email was sent.', { exact: true }).waitFor();
    assert((await page.locator('#invitation-link').inputValue()).includes('/join/'));
    await capture(page, output, 'unopened-invite');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  async function modelAnswered() {
    await page.goto(`${origin}/org/models`);
    await page.getByText('Model answered', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#provider-key').count(), 0);
    await capture(page, output, 'model-answered');
  }
  async function changeHistory() {
    await page.goto(`${origin}/org/history`);
    let sawLimits = false;
    let sawGroups = false;
    let historyPage = 0;
    for (;;) {
      await page.getByText('History loaded', { exact: true }).waitFor();
      const text = await page.locator('oc-audit').innerText();
      sawLimits ||= text.includes('budget.ceiling_set');
      sawGroups ||= text.includes('group.created');
      await capture(page, output, `change-history-${historyPage}`);
      historyPage += 1;
      if (sawLimits && sawGroups) break;
      const older = page.getByRole('button', { name: 'Older history', exact: true });
      assert.equal(await older.count(), 1, 'Change history must include limits and groups');
      await older.click();
    }
    await capture(page, output, 'change-history');
  }
  for (const run of [actionHistory, groupAndInvite, modelAnswered, changeHistory]) {
    const started = performance.now();
    let result = 'FAIL';
    try {
      await run();
      result = 'PASS';
    } catch {
      await capture(page, output, `${run.name}-failure`);
    }
    results.push({ step: run.name, result, elapsedMs: Math.round(performance.now() - started) });
    await writeFile(`${output}/pages.json`, JSON.stringify(results, null, 2), { mode: 0o600 });
  }
  for (const result of results) assert.equal(result.result, 'PASS', result.step);
}

try {
  demoStackId(process.env['DEV_STACK_ID']);
  const attempt = process.env['P4_JOURNEY_ATTEMPT'];
  assert(attempt && /^[a-zA-Z0-9-]+$/u.test(attempt), 'A safe rehearsal attempt is required');
  const { directory, root, readEnv, authEnv } = await import('./config.ts');
  const marker = await readFile(`${directory}/stack-owner`, 'utf8');
  assert(marker === root || marker.startsWith(`worktree=${root}\n`), 'Foreign stack');
  const settings = await readEnv('settings');
  assert.equal(settings['DEV_REAL_PROVIDER'], '1');
  const { browserSessions } = await import('./browser-signin.ts');
  const origin = settings['ORIGIN']!;
  const browser = await browserSessions(loadAuthConfig(await authEnv()), origin);
  const output = `${directory}/demo-pages/${attempt}`;
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(`${output}/source.txt`, `${sha}\n`, { mode: 0o600 });
    browser.ownerPage.setDefaultTimeout(30_000);
    await checkPages(browser.ownerPage, origin, output);
    console.log('PASS demo history, group, unopened invitation and model pages');
  } finally {
    await browser.close();
  }
} catch {
  console.error('Demo page checks incomplete; inspect private slot receipts.');
  process.exitCode = 1;
}
