import assert from 'node:assert/strict';
import type { Page } from 'playwright';

export async function checkProviderAnswer(owner: Page) {
  const models = owner.locator('oc-models main');
  await models.getByText('Model answered', { exact: true }).waitFor();
  assert.equal(await owner.locator('input[type="password"]:visible').count(), 0);
  const text = await owner.locator('body').innerText();
  assert(!/sk-[A-Za-z0-9_-]{12,}/u.test(text), 'Provider key is hidden');
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
  capture: (result: string) => Promise<void>, sanitise: (value: string) => string) {
  const started = performance.now();
  let result = 'PASS';
  let reason: string | undefined;
  let additionalReasons: string[] | undefined;
  let pictureReason: string | undefined;
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
    await capture(result);
  } catch (error) {
    if (result === 'FAIL') {
      pictureReason = failureReason(error, sanitise);
    } else {
      result = 'FAIL';
      reason = failureReason(error, sanitise);
    }
  }
  return { result, reason, additionalReasons, pictureReason,
    elapsedMs: Math.round(performance.now() - started) };
}
