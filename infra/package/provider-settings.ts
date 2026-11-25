import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page, Response } from 'playwright';
import { z } from 'zod';

const verificationFacts = {
  'Check provider reachability': 'reachable',
  'Run priced test': 'modelAnswer',
} as const;
type VerificationAction = keyof typeof verificationFacts;
type VerificationOutcome = 'pass' | 'fail';
const factSchema = z.object({ outcome: z.string() });
const verificationStatus = z.object({
  rows: z.array(z.object({ reachable: factSchema.optional(), modelAnswer: factSchema.optional() })),
});

export function providerSetup(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Connect a provider', exact: true });
}

export async function checkProviderStatus(page: Page): Promise<void> {
  const setup = providerSetup(page);
  const check = setup.getByRole('button', { name: 'Check status', exact: true });
  if (await check.isVisible()) {
    await check.click();
  }
}

export async function verifyProvider(
  page: Page, providerUrl: string, action: VerificationAction, outcome: VerificationOutcome,
): Promise<void> {
  const setup = providerSetup(page);
  const submit = setup.getByRole('button', { name: action, exact: true });
  const verificationUrl = `${providerUrl}/verify`;
  function isSubmission(response: Response): boolean {
    return response.url() === verificationUrl && response.request().method() === 'POST';
  }
  // Clicking starts the command. Wait for its reply before checking the saved outcome.
  const submitted = page.waitForResponse(isSubmission);
  const [response] = await Promise.all([submitted, submit.click()]);
  assert.equal(response.status(), 200, 'Provider verification submission failed');
  await waitForVerificationFact(page, providerUrl, verificationFacts[action], outcome);
  await checkProviderStatus(page);
}

async function waitForVerificationFact(
  page: Page, providerUrl: string, fact: 'reachable' | 'modelAnswer', outcome: VerificationOutcome,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(providerUrl);
    assert.equal(response.status(), 200, 'Provider status read failed');
    const result = verificationStatus.parse(await response.json());
    if (result.rows[0]?.[fact]?.outcome === outcome) return;
    await delay(100);
  }
  throw new Error('Provider verification did not reach the expected terminal outcome');
}

export async function finishSelectingProviderModels(page: Page): Promise<void> {
  await waitForProviderStep(page, 'Step 5 of 6 · Access');
}

export async function createProviderConnection(page: Page, name: string): Promise<void> {
  const actions = page.locator('.page-actions');
  await actions.getByRole('button', { name: 'Connect a provider', exact: true }).click();
  const setup = providerSetup(page);
  await setup.getByLabel('Connection name Required', { exact: true }).fill(name);
  await setup.getByRole('button', { name: 'Next', exact: true }).click();
  await waitForProviderStep(page, 'Step 2 of 6 · Key');
}

async function waitForProviderStep(page: Page, title: string): Promise<void> {
  const setup = providerSetup(page);
  const nextStep = setup.getByRole('heading', { name: title, exact: true });
  const statusButton = setup.getByRole('button', { name: 'Check status', exact: true });
  const enabledButtons = setup.locator('button:enabled');
  const check = statusButton.and(enabledButtons);
  const progress = nextStep.or(check);
  const deadline = Date.now() + 30_000;
  // Read the pending change through the control offered to the person; never resend it.
  while (Date.now() < deadline) {
    await progress.waitFor();
    if (await nextStep.isVisible()) return;
    // Keep the heading as a harmless click target if advancement removes Check status
    // while Playwright moves to it. Waiting only for the old button would miss that step.
    await progress.click();
  }
  throw new Error('Provider setup did not reach the next step');
}

export async function enterProviderKey(page: Page, credential: string): Promise<void> {
  const setup = providerSetup(page);
  await setup.getByRole('heading', { name: 'Step 2 of 6 · Key', exact: true }).waitFor();
  await setup.getByLabel('API key Required', { exact: true }).fill(credential);
}

export async function saveProviderKey(page: Page, credential: string): Promise<void> {
  await enterProviderKey(page, credential);
  const setup = providerSetup(page);
  await setup.getByRole('button', { name: 'Save key', exact: true }).click();
  await waitForProviderStep(page, 'Step 3 of 6 · Verify');
}
