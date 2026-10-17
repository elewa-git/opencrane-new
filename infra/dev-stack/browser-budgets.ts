/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'playwright';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
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
  async function summary() {
    return readBudgetSummary(owner, origin);
  }
  await owner.goto(`${origin}/org/spending`);
  await owner.getByText('Spending loaded', { exact: true }).waitFor();
  const starting = await summary();
  const groupId = starting.defaultPayingGroupId;
  assert(groupId);
  if (run === 'repeat') {
    assert.equal(starting.dailyCeilingCents, 5000, 'Plain startup preserves the owner daily cap');
    for (const scope of ['paying_group', 'assistant'] as const) assert.equal(starting.ceilings.find(row => row.scope === scope && row.scopeId === (scope === 'assistant' ? assistantId : groupId))?.ceilingCents, 20000, 'Plain startup preserves the owner monthly ceilings');
  }
  const save = async (scope: 'global' | 'paying_group' | 'assistant', scopeId: string, cents: number) => {
    await owner.goto(`${origin}/org/spending`);
    const budgetScope = owner.getByLabel('Budget scope', { exact: true });
    await budgetScope.waitFor({ state: 'visible' });
    await budgetScope.selectOption(scope);
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
      const scopeId = scope === 'assistant' ? assistantId : groupId;
      try {
        await save(scope, scopeId, 0);
        await owner.screenshot({ path: `${output}/${run}-${scope}-${width}.png`, fullPage: true });
        const conversationId = new URL(member.url()).searchParams.get('conversation');
        assert(conversationId);
        const head = await store.head();
        const notices = await member.locator('oc-budget-stop-notice').count();
        const budgetBefore = await history(store, `budget-${silo}`, silo);
        const reservations = budgetBefore.filter(isReservation).length;
        const prompt = `Ceiling refusal: ${scope} at ${width}px.`;
        await member.getByRole('textbox', { name: 'Message your agent' }).fill(prompt);
        await member.getByRole('button', { name: 'Send message', exact: true }).click();
        await member.waitForFunction(hasNewBudgetNotice, notices);
        const notice = member.locator('oc-budget-stop-notice').last();
        await notice.waitFor();
        await waitForBudgetNoticeToSettle(notice);
        assert((await notice.innerText()).includes('An Owner or Admin can review the limit'));
        assert((await notice.innerText()).includes('next monthly budget period (UTC)'));
        await member.reload();
        await member.waitForFunction(hasNewBudgetNotice, notices);
        await notice.waitFor();
        await waitForBudgetNoticeToSettle(notice);
        const rows = [];
        const after = await store.head();
        for await (const row of readEvents(store, head + 1, after)) {
          rows.push(row.event);
        }
        function isBudgetRefusal(event: EventEnvelope) {
          if (event.type !== 'decision.recorded') {
            return false;
          }
          const data = event.data as { reason: string; conversationId: string };
          return data.reason === 'budget_exhausted' && data.conversationId === conversationId;
        }
        assert(rows.some(isBudgetRefusal), 'New call has a durable budget refusal');
        const budgetAfter = await history(store, `budget-${silo}`, silo);
        const reservationsAfter = budgetAfter.filter(isReservation).length;
        assert.equal(reservationsAfter, reservations, 'Refused call reserves no money');
        const refusalScreenshot = {
          path: `${output}/${run}-${scope}-refusal-${width}.png`, fullPage: true,
        };
        await member.screenshot(refusalScreenshot);
        const savedMessage = `PASS ${run} ${width}px: owner saves ${scope} ceiling in UI; `;
        console.log(`${savedMessage}over-ceiling stub call refused and retained after reload`);
      } finally {
        // Restore through the API even when the Spending page cannot load.
        await restoreBudgetCeiling(owner, origin, store, silo, scope, scopeId);
      }
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

async function restoreBudgetCeiling(owner: Page, origin: string, store: EventStore,
  silo: string, scope: 'global' | 'paying_group' | 'assistant', scopeId: string) {
  const command = {
    commandId: randomUUID(), expectedSequence: await store.head(`budget-${silo}`),
    scope, ceilingCents: 20000,
    ...(scope === 'global' ? { dailyCeilingCents: 5000 } : { scopeId }),
  };
  const request = { headers: { origin }, data: command };
  const response = await owner.request.post(`${origin}/api/org/models`, request);
  assert.equal(response.status(), 200, `Restore the ${scope} test ceiling`);
  const body = await response.json() as { budget: unknown };
  const saved = budgetSummarySchema.parse(body.budget);
  const deadline = Date.now() + 90_000;
  let projected = await readBudgetSummary(owner, origin);
  while (projected.sequence < saved.sequence) {
    assert(Date.now() < deadline, 'Restored ceilings reach the budget projection');
    await delay(100);
    projected = await readBudgetSummary(owner, origin);
  }
}

async function readBudgetSummary(owner: Page, origin: string) {
  const response = await owner.request.get(`${origin}/api/org/models`);
  assert.equal(response.status(), 200);
  const body = await response.json() as { budget: unknown };
  return budgetSummarySchema.parse(body.budget);
}

export async function restoreBudgetCeilings(owner: Page, origin: string, store: EventStore,
  silo: string, assistantId: string) {
  const summary = await readBudgetSummary(owner, origin);
  const groupId = summary.defaultPayingGroupId;
  assert(groupId);
  const scopes = [
    { scope: 'paying_group' as const, scopeId: groupId },
    { scope: 'assistant' as const, scopeId: assistantId },
    { scope: 'global' as const, scopeId: groupId },
  ];
  const failures: unknown[] = [];
  for (const { scope, scopeId } of scopes) {
    try {
      await restoreBudgetCeiling(owner, origin, store, silo, scope, scopeId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not restore every test ceiling');
  }
}


function isReservation(row: StoredEvent) {
  return row.event.type === 'budget.reserved';
}

function hasNewBudgetNotice(count: number) {
  return document.querySelectorAll('oc-budget-stop-notice').length > count;
}

async function waitForBudgetNoticeToSettle(notice: Locator) {
  await notice.getByText('Checking stop details', { exact: true }).waitFor({ state: 'hidden' });
}
