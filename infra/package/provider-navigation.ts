import type { Browser, Page } from 'playwright';

export async function navigateWithReplies(page: Page, url: string,
  replies: Promise<void>[]): Promise<void> {
  // Finish body inspection while the old document still owns its network responses.
  await page.waitForLoadState('networkidle');
  await Promise.all(replies);
  await page.goto(url);
}

export async function finishBrowserReplies(browser: Browser,
  replies: Promise<void>[]): Promise<void> {
  // Read current bodies before closing, then check replies that finish during shutdown.
  await Promise.all(replies);
  await browser.close();
  await Promise.all(replies);
}
