/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { history, migrateBudgetDefault } from '@opencrane/models';
import { budgetSummarySchema } from '@opencrane/protocol';
import { readEvents } from '@opencrane/projections';
import { directory, root } from './config.ts';

/** Real owner edits and member refusals against the secondary stack's stub provider. */
export async function browserBudgetJourney(owner: Page, members: Page[], origin: string, store: EventStore, silo: string, assistantId: string) {
  const output = `${root}/docs/process/p3-13-live`;
  await mkdir(output, { recursive: true });
  const ceilings = async () => (await history(store, `budget-${silo}`, silo)).filter(row => row.event.type === 'budget.ceiling_set');
  const before = await ceilings();
  const run = before.some(row => !['installation', 'dev-only-stub-journey'].includes((row.event.data as { setBy: string }).setBy)) ? 'repeat' : 'fresh';
  for (const width of [1280, 390]) await copyFile(`${directory}/workspace-${width}.png`, `${output}/${run}-stub-chat-${width}.png`);
  assert.equal(before.filter(row => (row.event.data as { setBy: string }).setBy === 'installation').length, 1, 'Startup seeds the installation default exactly once');
  await migrateBudgetDefault(store, silo, 'must-not-replace-default');
  await migrateBudgetDefault(store, silo, 'must-not-replace-default');
  assert.deepEqual(await ceilings(), before, 'Repeated migration preserves all ceilings and the default without appending');
  console.log(`PASS ${run}: default paying group migration is idempotent; one installation event, existing ceilings preserved`);
  const summary = async () => {
    const response = await owner.request.get(`${origin}/api/org/models`);
    assert.equal(response.status(), 200);
    return budgetSummarySchema.parse((await response.json() as { budget: unknown }).budget);
  };
  const starting = await summary();
  const groupId = starting.defaultPayingGroupId;
  assert(groupId);
  if (run === 'repeat') {
    assert.equal(starting.dailyCeilingCents, 5000, 'Plain startup preserves the owner daily cap');
    for (const scope of ['paying_group', 'assistant'] as const) assert.equal(starting.ceilings.find(row => row.scope === scope && row.scopeId === (scope === 'assistant' ? assistantId : groupId))?.ceilingCents, 20000, 'Plain startup preserves the owner monthly ceilings');
  }
  const save = async (scope: 'global' | 'paying_group' | 'assistant', scopeId: string, cents: number) => {
    await owner.goto(`${origin}/org/spending`);
    await owner.getByText('Spending loaded', { exact: true }).waitFor();
    await owner.getByLabel('Budget scope', { exact: true }).selectOption(scope);
    if (scope === 'global') await owner.getByLabel('Daily safety cap (euro cents)', { exact: true }).fill('5000');
    else await owner.getByLabel(scope === 'assistant' ? 'Assistant id' : 'Paying group id', { exact: true }).fill(scopeId);
    await owner.getByLabel('Monthly ceiling (euro cents)', { exact: true }).fill(String(cents));
    const saving = owner.waitForResponse(response => response.url() === `${origin}/api/org/models` && response.request().method() === 'POST');
    await owner.getByRole('button', { name: 'Save budget', exact: true }).click();
    const response = await saving;
    assert.equal(response.status(), 200);
    const saved = budgetSummarySchema.parse((await response.json() as { budget: unknown }).budget);
    await owner.getByText('Budget saved', { exact: true }).waitFor();
    const deadline = Date.now() + 90_000;
    let projected = await summary();
    while (projected.sequence < saved.sequence) {
      assert(Date.now() < deadline, 'Saved ceiling reaches the budget projection');
      await delay(100); projected = await summary();
    }
    if (scope === 'global') { assert.equal(projected.ceilingCents, cents); assert.equal(projected.dailyCeilingCents, 5000); assert.equal(projected.defaultPayingGroupId, groupId); }
    else assert.equal(projected.ceilings.find(row => row.scope === scope && row.scopeId === scopeId)?.ceilingCents, cents);
    assert(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Budget editor fits the viewport');
  };
  for (const width of [1280, 390]) {
    await owner.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const member = members.find(page => page.viewportSize()?.width === width);
    assert(member);
    for (const scope of ['paying_group', 'assistant'] as const) {
      await save('paying_group', groupId, 20000);
      await save('assistant', assistantId, 20000);
      await save(scope, scope === 'assistant' ? assistantId : groupId, 0);
      await owner.screenshot({ path: `${output}/${run}-${scope}-${width}.png`, fullPage: true });
      const conversationId = new URL(member.url()).searchParams.get('conversation');
      assert(conversationId);
      const head = await store.head();
      const notices = await member.locator('oc-budget-stop-notice').count();
      const reservations = (await history(store, `budget-${silo}`, silo)).filter(row => row.event.type === 'budget.reserved').length;
      await member.getByRole('textbox', { name: 'Message your agent' }).fill(`Ceiling refusal: ${scope} at ${width}px.`);
      await member.getByRole('button', { name: 'Send message', exact: true }).click();
      await member.waitForFunction(count => document.querySelectorAll('oc-budget-stop-notice').length > count, notices);
      const notice = member.locator('oc-budget-stop-notice').last();
      await notice.waitFor();
      assert((await notice.innerText()).includes('An Owner or Admin can review the limit'));
      assert((await notice.innerText()).includes('next monthly budget period (UTC)'));
      await member.reload();
      await member.waitForFunction(count => document.querySelectorAll('oc-budget-stop-notice').length > count, notices);
      await notice.waitFor();
      const rows = [];
      for await (const row of readEvents(store, (head ?? 0) + 1, (await store.head())!)) rows.push(row.event);
      assert(rows.some(event => event.type === 'decision.recorded' && (event.data as { reason: string; conversationId: string }).reason === 'budget_exhausted' && (event.data as { conversationId: string }).conversationId === conversationId), 'New call has a durable budget refusal');
      assert.equal((await history(store, `budget-${silo}`, silo)).filter(row => row.event.type === 'budget.reserved').length, reservations, 'Refused call reserves no money');
      await member.screenshot({ path: `${output}/${run}-${scope}-refusal-${width}.png`, fullPage: true });
      console.log(`PASS ${run} ${width}px: owner saves ${scope} ceiling in UI; over-ceiling stub call refused with clear reason, retained after reload`);
    }
  }
  if (run === 'fresh') {
    // Stop retains unconfirmed reservations; leave enough headroom for plain startup.
    await save('paying_group', groupId, 20000);
    await save('assistant', assistantId, 20000);
    await save('global', groupId, 20000);
    await owner.screenshot({ path: `${output}/fresh-repeat-headroom-390.png`, fullPage: true });
  }
}
