import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'playwright';

export async function waitForUpload(
  page: Page,
  name: string,
  target: (control: Locator) => Promise<void>,
  expected = 'Ready',
): Promise<number> {
  const attachments = page.getByRole('list', { name: 'Attachments', exact: true });
  const items = attachments.getByRole('listitem');
  const filename = page.getByText(name, { exact: true });
  const chip = items.filter({ has: filename });
  const status = chip.getByRole('status');
  const retry = chip.getByRole('button', { name: 'Retry upload', exact: true });
  const expectedStatus = status.filter({ hasText: expected });
  const terminal = expectedStatus.or(retry);
  // A refused chip shows both its reason and Retry; either confirms completion.
  // The transport has its own 120-second timeout. A terminal refusal must be visible too.
  for (let attempt = 0; attempt < 3; attempt++) {
    await terminal.first().waitFor({ timeout: 130_000 });
    const message = await status.innerText();
    if (message.includes(expected)) return attempt;
    assert(message.includes('Upload unavailable')
      || message.includes('Upload acknowledgement unavailable'), message);
    assert(attempt < 2, 'Upload stayed unavailable after two retries');
    await delay(1000);
    await target(retry);
    await retry.click();
  }
  throw new Error('Upload did not reach the expected status');
}
