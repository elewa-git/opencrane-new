import type { Page } from 'playwright';

export async function navigateWithReplies(page: Page, url: string,
  replies: Promise<void>[]): Promise<void> {
  // Finish body inspection while the old document still owns its network responses.
  await page.waitForLoadState('networkidle');
  await Promise.all(replies);
  await page.goto(url);
}
