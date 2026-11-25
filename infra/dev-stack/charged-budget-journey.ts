import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { assertAuditMoney, readSuccessfulTurnAudit } from './browser-audit.ts';
import { findBudgetNoticeForPrompt, loadBudgetEditor, readBudgetSummary, saveBudgetCeiling,
  scopedBudget } from './browser-budgets.ts';
import { openBudgetConversation, prepareBudgetAssistant, type BudgetAssistant }
  from './budget-fixture.ts';
import { answer, sendForReply } from './real-model-journey.ts';
import type { BeforePageNavigation } from './browser-signin.ts';

export type ChargedBudgetJourney = {
  owner: Page;
  admin: Page;
  member: Page;
  memberId: string;
  origin: string;
  readRequestCount: () => Promise<number>;
  capture: (page: Page, name: string, width: number) => Promise<void>;
  step: (check: string, detail: string) => void;
  beforeNavigate?: BeforePageNavigation;
};

async function waitForCharge(admin: Page, origin: string, groupId: string, previousCents: number) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const budget = await readBudgetSummary(admin, origin);
    const group = scopedBudget(budget, 'paying_group', groupId);
    if (budgetChargeSettled(group, previousCents)) {
      return group.monthCents;
    }
    await delay(100);
  }
  assert.fail('Spending records a charge and clears its reservation');
}

async function showSettledCost(admin: Page, origin: string, groupId: string, cents: number,
  beforeNavigate?: BeforePageNavigation) {
  await loadBudgetEditor(admin, origin, undefined, beforeNavigate);
  const heading = admin.getByRole('heading', { name: `Paying group · ${groupId}`, exact: true });
  const card = admin.getByRole('article').filter({ has: heading });
  const settled = card.locator('dt').filter({ hasText: /^Settled$/u });
  const amount = settled.locator('xpath=following-sibling::dd[1]');
  await amount.filter({ hasText: `(${cents} cents)` }).waitFor({ state: 'visible' });
}

export async function chooseMemoryFreeTurn(member: Page) {
  const mode = member.getByRole('group', { name: 'Turn memory mode', exact: true });
  const choice = { name: 'Start a fresh memory-free turn', exact: true };
  await mode.getByRole('button', choice).click();
}

async function refuseNextTurn(member: Page, prompt: string) {
  await chooseMemoryFreeTurn(member);
  await sendForReply(member, prompt);
  const notice = await findBudgetNoticeForPrompt(member, prompt);
  await notice.getByText(/^Group monthly limit reached/u).waitFor({ state: 'visible' });
  await notice.getByText(/Ask an admin to review the limit/u).waitFor({ state: 'visible' });
}

async function qualifyWidth(journey: ChargedBudgetJourney, assistant: BudgetAssistant,
  width: number) {
  const { admin, member, origin, readRequestCount, capture, step, beforeNavigate } = journey;
  const { groupId } = assistant;
  const viewport = { width, height: width === 390 ? 844 : 900 };
  await admin.setViewportSize(viewport);
  await member.setViewportSize(viewport);
  step(`save monthly ceiling at ${width}px`, 'Spending must confirm the saved group ceiling.');
  const scope = 'paying_group';
  const ceilingCents = 500;
  const starting = await saveBudgetCeiling(admin, origin, { scope, scopeId: groupId,
    cents: ceilingCents }, beforeNavigate);
  const previousCents = scopedBudget(starting, scope, groupId).monthCents;
  await capture(admin, 'monthly-ceiling', width);

  step(`open member chat at ${width}px`, 'The shared assistant session must open for the member.');
  await openBudgetConversation(member, origin, assistant, beforeNavigate);
  step(`charge member turn at ${width}px`,
    'The member must receive a reply and Spending must show its charge in whole euro cents.');
  const requestsBefore = await readRequestCount();
  // Exercise a saved reply without depending on private-memory deployment settings.
  await chooseMemoryFreeTurn(member);
  const prompt = `Say hello briefly at ${width}px.`;
  await answer(member, prompt, [/^Hello from your computer\.$/u], beforeNavigate);
  const spentCents = await waitForCharge(admin, origin, groupId, previousCents);
  const { row } = await readSuccessfulTurnAudit(member, origin, prompt);
  const { reservedCents, chargedCents } = await assertAuditMoney(admin, origin, row);
  const requestsAfterReply = await readRequestCount();
  const observation = { reservedCents, chargedCents, spentCents, previousCents,
    requestsBefore, requestsAfterReply };
  assertChargedTurn(observation);
  await capture(member, 'charged-reply', width);
  await showSettledCost(admin, origin, groupId, spentCents, beforeNavigate);
  await capture(admin, 'settled-spending', width);

  step(`lower monthly ceiling at ${width}px`, 'The saved ceiling must be below recorded spending.');
  const loweredCents = spentCents - 1;
  const lowered = await saveBudgetCeiling(admin, origin, { scope, scopeId: groupId,
    cents: loweredCents }, beforeNavigate);
  const loweredGroup = scopedBudget(lowered, scope, groupId);
  assertBelowRecordedSpending(loweredGroup.monthCents, loweredCents);
  await capture(admin, 'lowered-ceiling', width);

  step(`refuse next turn at ${width}px`,
    'Chat must explain the group limit and the stand-in request count must stay the same.');
  await refuseNextTurn(member, `Try another answer at ${width}px.`);
  const requestsAfterRefusal = await readRequestCount();
  assertRefusedRequestCount(requestsAfterRefusal, requestsAfterReply);
  await capture(member, 'budget-refused', width);
  return { check: `monthly spending and chat refusal at ${width}px`, result: 'PASS', width,
    ceilingCents, reservedCents, chargedCents, spentCents, loweredCents,
    requestsBefore, requestsAfterReply, requestsAfterRefusal };
}

export async function chargedBudgetJourney(journey: ChargedBudgetJourney) {
  const { owner, origin, memberId, step } = journey;
  step('budget journey setup', 'The shared assistant must be available to the member.');
  const assistant = await prepareBudgetAssistant(owner, [], origin, memberId);
  const outcomes = [];
  for (const width of [1280, 390]) {
    const outcome = await qualifyWidth(journey, assistant, width);
    outcomes.push(outcome);
    console.log(`PASS ${width}px: reserved ${outcome.reservedCents} cents, charged ` +
      `${outcome.chargedCents} cents, refused at ${outcome.loweredCents} cents with ` +
      `${outcome.requestsAfterRefusal} stand-in requests before and after refusal`);
  }
  return outcomes;
}

type GroupSpend = { monthCents: number; reservedCents: number };

export function budgetChargeSettled(group: GroupSpend, previousCents: number): boolean {
  return group.monthCents > previousCents && group.reservedCents === 0;
}

type TurnChargeObservation = {
  reservedCents: number;
  chargedCents: number;
  spentCents: number;
  previousCents: number;
  requestsBefore: number;
  requestsAfterReply: number;
};

export function assertChargedTurn(observation: TurnChargeObservation): void {
  const { reservedCents, chargedCents, spentCents, previousCents,
    requestsBefore, requestsAfterReply } = observation;
  assert(reservedCents > 0 && chargedCents > 0, 'The call has a positive reservation and charge');
  assert.equal(spentCents - previousCents, chargedCents, 'Spending shows this turn’s charge');
  assert.equal(requestsAfterReply, requestsBefore + 1, 'One member call reached the stand-in');
}

export function assertBelowRecordedSpending(spentCents: number, loweredCents: number): void {
  assert(spentCents > loweredCents, 'The saved ceiling is below recorded spending');
}

export function assertRefusedRequestCount(after: number, before: number): void {
  assert.equal(after, before, 'The refused call did not reach the stand-in');
}
