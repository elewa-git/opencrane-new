import type { Page } from 'playwright';

export async function createProviderConnection(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Connect a provider', exact: true }).first().click();
  await page.getByLabel('Connection name').fill(name);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
}

export async function enterProviderKey(page: Page, credential: string): Promise<void> {
  await page.getByLabel('API key', { exact: false }).fill(credential);
}
