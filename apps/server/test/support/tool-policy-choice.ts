import { expect } from 'vitest';
import { toolPolicySchema } from '@opencrane/protocol';
import type { Page, Response } from 'playwright';

export async function chooseToolMode(
  page: Page, serverId: string, toolName: string, modeLabel: string,
) {
  const groupOptions = { name: toolName };
  const group = page.getByRole('group', groupOptions);
  const labels = group.locator('label');
  const labelFilter = { hasText: modeLabel };
  const choice = labels.filter(labelFilter);
  await choice.click();
  function savedPolicy(response: Response) {
    const request = response.request();
    return request.method() === 'POST' && response.url().endsWith(`/${serverId}/tools`);
  }
  const saving = page.waitForResponse(savedPolicy);
  const saveOptions = { name: `Save mode for ${toolName}`, disabled: false };
  const save = page.getByRole('button', saveOptions);
  // Wait for Angular to enable Save before sending a keyboard action.
  await save.press('Enter');
  const response = await saving;
  expect(response.status()).toBe(200);
  const message = `Saved ${toolName}: ${modeLabel}`;
  const confirmation = page.getByText(message);
  await confirmation.waitFor();
}

export async function expectReviewedTools(response: Response) {
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const policy = toolPolicySchema.parse(body);
  expect(policy.tools).toHaveLength(2);
  expect(policy.tools[1]?.name).toBe('write');
}

export function waitForToolPolicy(page: Page, origin: string, serverId: string) {
  function policyResponse(response: Response) {
    const request = response.request();
    return request.method() === 'GET' &&
      response.url() === `${origin}/api/org/integrations/${serverId}/tools`;
  }
  return page.waitForResponse(policyResponse);
}
