/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page, Response } from 'playwright';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
import { history, migrateBudgetDefault } from '@opencrane/models';
import { budgetSummarySchema, type BudgetSummary } from '@opencrane/protocol';
import { readEvents } from '@opencrane/projections';
import { postJourneyCommand, readJourneyApi } from './browser-api.ts';
import { directory, root } from './config.ts';
import type { BeforePageNavigation } from './browser-signin.ts';

export type BudgetJourneyInput = { silo: string; assistantId: string; groupId: string };

/** Check owner budget edits and member refusals with the spare stack's test model. */
export async function browserBudgetJourney(owner: Page, members: Page[], origin: string,
  store: EventStore, input: BudgetJourneyInput) {
  const { silo, assistantId, groupId } = input;
  await requireSharedAssistant(store, silo, assistantId);
  const output = `${root}/docs/process/p3-13-live`;
  await mkdir(output, { recursive: true });
  const run = await checkBudgetMigration(store, silo, output);
  await owner.goto(`${origin}/org/spending`);
  await owner.getByText('Spending loaded', { exact: true }).waitFor();
  const starting = await readBudgetSummary(owner, origin);
  const defaultPayingGroupId = starting.defaultPayingGroupId;
  assert(defaultPayingGroupId);
  if (run === 'repeat') {
    assertRepeatCeilings(starting, assistantId, groupId);
  }
  const groupLimit: JourneyBudgetCeiling = {
    scope: 'paying_group', scopeId: groupId, cents: 20000,
  };
  const assistantLimit: JourneyBudgetCeiling = {
    scope: 'assistant', scopeId: assistantId, cents: 20000,
  };
  for (const width of [1280, 390]) {
    const viewport = { width, height: width === 390 ? 844 : 900 };
    await owner.setViewportSize(viewport);
    function matchesWidth(page: Page) {
      return page.viewportSize()?.width === width;
    }
    const member = members.find(matchesWidth);
    assert(member);
    for (const scope of ['paying_group', 'assistant'] as const) {
      await saveBudgetCeiling(owner, origin, groupLimit);
      await saveBudgetCeiling(owner, origin, assistantLimit);
      const scopeId = scope === 'assistant' ? assistantId : groupId;
      const target = { scope, scopeId };
      const refusalLimit = { scope, scopeId, cents: 0 };
      try {
        await saveBudgetCeiling(owner, origin, refusalLimit);
        const savedScreenshot = {
          path: `${output}/${run}-${scope}-${width}.png`, fullPage: true,
        };
        await owner.screenshot(savedScreenshot);
        const prompt = `Ceiling refusal: ${scope} at ${width}px.`;
        await assertBudgetRefusal(member, store, silo, prompt);
        const refusalScreenshot = {
          path: `${output}/${run}-${scope}-refusal-${width}.png`, fullPage: true,
        };
        await member.screenshot(refusalScreenshot);
        console.log(`PASS ${run} ${width}px: owner saves ${scope} ceiling in UI; ` +
          'over-ceiling test-model call refused and retained after reload');
      } finally {
        // Restore through the API even when the Spending page cannot load.
        await restoreBudgetCeiling(owner, origin, store, silo, target);
      }
    }
  }
  if (run === 'fresh') {
    // Leave room for a restart: Stop keeps reservations without confirmed usage.
    await saveBudgetCeiling(owner, origin, groupLimit);
    await saveBudgetCeiling(owner, origin, assistantLimit);
    const globalLimit: JourneyBudgetCeiling = { scope: 'global', dailyCents: 5000, cents: 20000 };
    const global = await saveBudgetCeiling(owner, origin, globalLimit);
    assert.equal(global.defaultPayingGroupId, defaultPayingGroupId);
    const screenshot = { path: `${output}/fresh-repeat-headroom-390.png`, fullPage: true };
    await owner.screenshot(screenshot);
  }
}

async function requireSharedAssistant(store: EventStore, silo: string, assistantId: string) {
  const assistantRows = await history(store, `assistant-${assistantId}`, silo);
  function isSharedAssistant(row: StoredEvent) {
    const data = row.event.data as { kind?: string };
    return row.event.type === 'assistant.created' && data.kind === 'team';
  }
  assert(assistantRows.some(isSharedAssistant),
    'Budget notices must use a shared assistant that the owner can choose in Spending');
}

async function readCeilings(store: EventStore, silo: string) {
  const rows = await history(store, `budget-${silo}`, silo);
  return rows.filter(isCeiling);
}

function isCeiling(row: StoredEvent) {
  return row.event.type === 'budget.ceiling_set';
}

function isInstallationCeiling(row: StoredEvent) {
  const data = row.event.data as { setBy: string };
  return data.setBy === 'installation';
}

function isOwnerCeiling(row: StoredEvent) {
  const data = row.event.data as { setBy: string };
  return !['installation', 'dev-only-stub-journey'].includes(data.setBy);
}

async function checkBudgetMigration(store: EventStore, silo: string, output: string) {
  const before = await readCeilings(store, silo);
  const run = before.some(isOwnerCeiling) ? 'repeat' : 'fresh';
  for (const width of [1280, 390]) {
    await copyFile(`${directory}/workspace-${width}.png`, `${output}/${run}-stub-chat-${width}.png`);
  }
  const installationCeilings = before.filter(isInstallationCeiling);
  assert.equal(installationCeilings.length, 1, 'Startup seeds the installation default exactly once');
  await migrateBudgetDefault(store, silo, 'must-not-replace-default');
  await migrateBudgetDefault(store, silo, 'must-not-replace-default');
  const after = await readCeilings(store, silo);
  assert.deepEqual(after, before,
    'Repeated migration preserves all ceilings and the default without appending');
  console.log(`PASS ${run}: default paying group migration is idempotent; ` +
    'one installation event, existing ceilings preserved');
  return run;
}

function assertRepeatCeilings(starting: BudgetSummary, assistantId: string, groupId: string) {
  assert.equal(starting.dailyCeilingCents, 5000, 'Plain startup preserves the owner daily cap');
  for (const scope of ['paying_group', 'assistant'] as const) {
    const scopeId = scope === 'assistant' ? assistantId : groupId;
    const ceiling = findScopedBudget(starting, scope, scopeId);
    assert.equal(ceiling?.ceilingCents, 20000, 'Plain startup preserves the owner monthly ceilings');
  }
}

async function assertBudgetRefusal(member: Page, store: EventStore, silo: string, prompt: string) {
  const location = new URL(member.url());
  const conversationId = location.searchParams.get('conversation');
  assert(conversationId);
  const head = await store.head();
  const budgetBefore = await history(store, `budget-${silo}`, silo);
  const reservations = budgetBefore.filter(isReservation);
  const composer = member.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill(prompt);
  const send = member.getByRole('button', { name: 'Send message', exact: true });
  await send.click();
  const notice = await findBudgetNoticeForPrompt(member, prompt);
  await waitForBudgetNoticeToSettle(notice);
  await assertSavedBudgetNotice(notice);
  await member.reload();
  const reloadedNotice = await findBudgetNoticeForPrompt(member, prompt);
  await waitForBudgetNoticeToSettle(reloadedNotice);
  await assertSavedBudgetNotice(reloadedNotice);
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
  const reservationsAfter = budgetAfter.filter(isReservation);
  assert.equal(reservationsAfter.length, reservations.length, 'Refused call reserves no money');
}

export type JourneyBudgetCeiling = { scope: 'global'; cents: number; dailyCents: number }
  | { scope: 'paying_group' | 'assistant'; scopeId: string; cents: number };

export function scopedBudget(budget: BudgetSummary,
  scope: 'paying_group' | 'assistant', scopeId: string) {
  const ceiling = findScopedBudget(budget, scope, scopeId);
  assert(ceiling, 'The saved spending scope is present');
  return ceiling;
}

function findScopedBudget(budget: BudgetSummary,
  scope: 'paying_group' | 'assistant', scopeId: string) {
  function matchesScope(row: BudgetSummary['ceilings'][number]) {
    return row.scope === scope && row.scopeId === scopeId;
  }
  return budget.ceilings.find(matchesScope);
}

export async function saveBudgetCeiling(owner: Page, origin: string, limit: JourneyBudgetCeiling,
  beforeNavigate?: BeforePageNavigation) {
  const budgetScope = await loadBudgetEditor(owner, origin, undefined, beforeNavigate);
  await budgetScope.selectOption(limit.scope);
  if (limit.scope === 'global') {
    const daily = owner.getByLabel('Daily safety cap (euro cents)', { exact: true });
    await daily.fill(String(limit.dailyCents));
  } else {
    const label = limit.scope === 'assistant' ? 'Assistant id' : 'Paying group id';
    await owner.getByLabel(label, { exact: true }).fill(limit.scopeId);
  }
  const monthly = owner.getByLabel('Monthly ceiling (euro cents)', { exact: true });
  await monthly.fill(String(limit.cents));
  function isSave(response: Response) {
    return response.url() === `${origin}/api/org/models` && response.request().method() === 'POST';
  }
  const saving = owner.waitForResponse(isSave);
  await owner.getByRole('button', { name: 'Save budget', exact: true }).click();
  const saved = await budgetFromResponse(await saving);
  await owner.getByText('Budget saved', { exact: true }).waitFor();
  const projected = await waitForProjectedBudget(owner, origin, saved.sequence);
  if (limit.scope === 'global') {
    assert.equal(projected.ceilingCents, limit.cents);
    assert.equal(projected.dailyCeilingCents, limit.dailyCents);
  } else {
    const ceiling = scopedBudget(projected, limit.scope, limit.scopeId);
    assert.equal(ceiling.ceilingCents, limit.cents);
  }
  assert(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Budget editor fits the viewport');
  return projected;
}

async function visibleState(locator: Locator): Promise<boolean | null> {
  try {
    return await locator.isVisible();
  } catch {
    // Keep unreadable pages distinct from a control that is absent.
    return null;
  }
}

async function readEditorState(owner: Page) {
  const budgetScope = owner.getByLabel('Budget scope', { exact: true });
  const unavailable = owner.getByText('Budget service unavailable', { exact: true });
  const accessChanged = owner.getByText('Spending needs the Owner or Admin role.', { exact: true });
  const loaded = owner.getByText('Spending loaded', { exact: true });
  const states = [visibleState(budgetScope), visibleState(unavailable),
    visibleState(accessChanged), visibleState(loaded)];
  const [budgetScopeVisible, budgetServiceUnavailable, accessChangedVisible, spendingLoaded]
    = await Promise.all(states);
  return { budgetScopeVisible, budgetServiceUnavailable,
    accessChanged: accessChangedVisible, spendingLoaded };
}

export async function loadBudgetEditor(owner: Page, origin: string,
  captureDirectory = directory, beforeNavigate?: BeforePageNavigation): Promise<Locator> {
  await beforeNavigate?.(owner);
  const budgetReadStatuses: number[] = [];
  const effectReadStatuses: number[] = [];
  function recordResponse(response: Response) {
    if (response.request().method() !== 'GET') {
      return;
    }
    if (response.url() === `${origin}/api/org/models`) {
      budgetReadStatuses.push(response.status());
    } else if (response.url() === `${origin}/api/org/effects`) {
      effectReadStatuses.push(response.status());
    }
  }
  owner.on('response', recordResponse);
  try {
    await owner.goto(`${origin}/org/spending`);
    const budgetScope = owner.getByLabel('Budget scope', { exact: true });
    await budgetScope.waitFor({ state: 'visible' });
    return budgetScope;
  } catch {
    // Keep the failed page's replies, rather than making new reads after the failure.
    const editorState = await readEditorState(owner);
    const evidence = JSON.stringify({ budgetReadStatuses, effectReadStatuses, editorState });
    const record = writeFile(`${captureDirectory}/budget-editor-failure.log`, evidence,
      { mode: 0o600 });
    const capture = captureBudgetEditorFailure(owner, captureDirectory);
    await Promise.allSettled([record, capture]);
    // Exclude browser errors because they can contain request or page contents.
    throw new Error('Spending budget editor did not load; inspect private evidence');
  } finally {
    owner.off('response', recordResponse);
  }
}

async function captureBudgetEditorFailure(owner: Page, captureDirectory: string): Promise<void> {
  // Keep page contents private, alongside the stack's other failure pictures.
  const picture = await owner.screenshot({ fullPage: true });
  await writeFile(`${captureDirectory}/budget-editor-failure.png`, picture, { mode: 0o600 });
}

export type BudgetCeilingTarget = {
  scope: 'global' | 'paying_group' | 'assistant';
  scopeId: string;
};

async function restoreBudgetCeiling(owner: Page, origin: string, store: EventStore,
  silo: string, target: BudgetCeilingTarget) {
  const { scope, scopeId } = target;
  const command = {
    commandId: randomUUID(), expectedSequence: await store.head(`budget-${silo}`),
    scope, ceilingCents: 20000,
    ...(scope === 'global' ? { dailyCeilingCents: 5000 } : { scopeId }),
  };
  const response = await postJourneyCommand(owner, origin, '/api/org/models', command);
  assert.equal(response.status(), 200, `Restore the ${scope} test ceiling`);
  const saved = await budgetFromResponse(response);
  await waitForProjectedBudget(owner, origin, saved.sequence);
}

async function waitForProjectedBudget(owner: Page, origin: string, sequence: number) {
  const deadline = Date.now() + 90_000;
  let projected = await readBudgetSummary(owner, origin);
  while (projected.sequence < sequence) {
    assert(Date.now() < deadline, 'Saved ceiling reaches the budget projection');
    await delay(100);
    projected = await readBudgetSummary(owner, origin);
  }
  return projected;
}

export async function readBudgetSummary(owner: Page, origin: string) {
  const response = await readJourneyApi(owner, `${origin}/api/org/models`);
  return budgetFromResponse(response);
}

async function budgetFromResponse(response: Pick<Response, 'status' | 'json'>) {
  assert.equal(response.status(), 200);
  const body = await response.json() as { budget: unknown };
  return budgetSummarySchema.parse(body.budget);
}

export async function restoreBudgetCeilings(owner: Page, origin: string, store: EventStore,
  input: BudgetJourneyInput) {
  const { silo, assistantId, groupId } = input;
  const scopes = [
    { scope: 'paying_group' as const, scopeId: groupId },
    { scope: 'assistant' as const, scopeId: assistantId },
    { scope: 'global' as const, scopeId: groupId },
  ];
  const failures: unknown[] = [];
  for (const target of scopes) {
    try {
      await restoreBudgetCeiling(owner, origin, store, silo, target);
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

export async function findBudgetNoticeForPrompt(member: Page, prompt: string): Promise<Locator> {
  const message = member.getByText(prompt, { exact: true });
  await message.waitFor({ state: 'visible' });
  const entry = message.locator('xpath=ancestor::article[1]');
  const agentTurn = entry.locator('xpath=following-sibling::article[1]');
  const notice = agentTurn.locator('oc-budget-stop-notice');
  await notice.waitFor({ state: 'attached' });
  return notice;
}

async function assertSavedBudgetNotice(notice: Locator): Promise<void> {
  const copy = await notice.innerText();
  assert(copy.includes('limit reached'), 'Saved budget notice names the reached limit');
  assert(copy.includes('Ask an admin to review the limit'),
    'Saved budget notice says an admin can review the limit');
  assert(copy.includes("Waiting for the reset won't help"),
    'A zero ceiling says waiting for the reset will not help');
  assert(!copy.includes('next monthly budget period'),
    'A zero ceiling does not suggest waiting for the next monthly period');
}

async function waitForBudgetNoticeToSettle(notice: Locator) {
  await notice.getByText('Checking stop details', { exact: true }).waitFor({ state: 'hidden' });
}
