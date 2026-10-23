import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';

export async function checkProviderAnswer(owner: Page) {
  const models = owner.locator('oc-models main [data-provider-id="dev-openai"]');
  await models.getByText('Model answered', { exact: true }).waitFor();
  assert.equal(await owner.locator('input[type="password"]:visible').count(), 0);
  const text = await owner.locator('body').innerText();
  assert(!/sk-[A-Za-z0-9_-]{12,}/u.test(text), 'Provider key is hidden');
}

export async function choosePerson(page: Page, origin: string, memberId: string) {
  const response = await page.request.get(`${origin}/api/chat/colleagues?limit=50`);
  assert.equal(response.status(), 200);
  const people = await response.json() as {
    rows: Array<{ memberId: string; displayName?: string }>;
  };
  function chosen(person: { memberId: string }) {
    return person.memberId === memberId;
  }
  const person = people.rows.find(chosen);
  assert(person, 'The selected colleague exists');
  const selectedName = person.displayName ?? person.memberId;
  await page.locator('#colleague-search').fill(selectedName);
  const label = page.getByText(selectedName, { exact: true });
  const choices = page.locator('.colleague-option');
  const matchingLabel = { has: label };
  const matchingPerson = choices.filter(matchingLabel);
  await matchingPerson.click();
}

function failureReason(error: unknown, sanitise: (value: string) => string) {
  try {
    if (error instanceof Error) {
      return sanitise(error.message);
    }
    if (typeof error === 'string') {
      return sanitise(error);
    }
  } catch {
    // Withhold the error if removing private values fails.
  }
  return 'Failure details withheld';
}

export async function rehearsalStep(run: () => Promise<void>,
  capture: (result: string) => Promise<string[]>, sanitise: (value: string) => string) {
  const started = performance.now();
  let result = 'PASS';
  let reason: string | undefined;
  let additionalReasons: string[] | undefined;
  let pictureReason: string | undefined;
  let pictures: string[] = [];
  function sanitisedReason(error: unknown) {
    return failureReason(error, sanitise);
  }
  try {
    await run();
  } catch (error) {
    result = 'FAIL';
    if (error instanceof AggregateError) {
      reason = sanitisedReason(error.errors[0]);
      const additionalErrors = error.errors.slice(1);
      additionalReasons = additionalErrors.map(sanitisedReason);
    } else {
      reason = sanitisedReason(error);
    }
  }
  try {
    pictures = await capture(result);
    assert(pictures.length > 0, 'Step picture missing');
  } catch (error) {
    if (result === 'FAIL') {
      pictureReason = failureReason(error, sanitise);
    } else {
      result = 'FAIL';
      reason = failureReason(error, sanitise);
    }
  }
  return { result, reason, additionalReasons, pictureReason, pictures,
    elapsedMs: Math.round(performance.now() - started) };
}

export async function checkChangeHistory(owner: Page,
  picture: (name: string) => Promise<void>) {
  await owner.getByRole('heading', { name: 'Change history', exact: true }).waitFor();
  let limitSeen = false;
  let groupSeen = false;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    await owner.locator('oc-audit article').first().waitFor();
    const text = await owner.locator('oc-audit').innerText();
    if (text.includes('budget.ceiling_set')) {
      limitSeen = true;
      const limits = owner.locator('oc-audit article').filter({ hasText: 'budget.ceiling_set' });
      await limits.first().scrollIntoViewIfNeeded();
      await picture('10-limit-history');
    }
    if (/team\.(created|member_added|member_removed)/u.test(text)) {
      groupSeen = true;
      const groups = owner.locator('oc-audit article').filter({
        hasText: /team\.(created|member_added|member_removed)/u,
      });
      await groups.first().scrollIntoViewIfNeeded();
      await picture('10-group-history');
    }
    if (limitSeen && groupSeen) {
      return;
    }
    const older = owner.getByRole('button', { name: 'Older history', exact: true });
    if (!await older.count()) {
      break;
    }
    await older.click();
    await delay(300);
  }
  assert(limitSeen && groupSeen, 'Change history shows limits and groups');
}
