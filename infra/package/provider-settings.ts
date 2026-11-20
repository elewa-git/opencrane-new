import type { Locator, Page } from 'playwright';

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
  const deadline = Date.now() + 30_000;
  // Read the pending change through the control offered to the person; never resend it.
  while (Date.now() < deadline) {
    await nextStep.or(check).waitFor();
    if (await nextStep.isVisible()) return;
    await check.click();
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
