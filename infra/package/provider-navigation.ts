import type { Page } from 'playwright';

export async function navigateWithReplies(page: Page, url: string,
  replies: Promise<void>[]): Promise<void> {
  await page.goto(url);
}
