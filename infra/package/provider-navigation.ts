import type { Browser, CDPSession, Page } from 'playwright';

type PausedReply = { requestId: string; responseStatusCode?: number };

async function inspectPausedReply(session: CDPSession, reply: PausedReply,
  inspect: (body: string) => void): Promise<void> {
  const request = { requestId: reply.requestId };
  if (reply.responseStatusCode === undefined) {
    // A transport failure has no HTTP body to inspect.
    await session.send('Fetch.continueRequest', request);
    return;
  }
  try {
    const response = await session.send('Fetch.getResponseBody', request);
    const body = response.base64Encoded
      ? Buffer.from(response.body, 'base64').toString('utf8')
      : response.body;
    inspect(body);
  } finally {
    await session.send('Fetch.continueResponse', request);
  }
}

export async function watchBrowserReplies(page: Page, origin: string, replies: Promise<void>[],
  inspect: (body: string) => void): Promise<void> {
  const context = page.context();
  const session = await context.newCDPSession(page);
  function onReply(reply: PausedReply): void {
    const inspection = inspectPausedReply(session, reply, inspect);
    void Promise.allSettled([inspection]);
    replies.push(inspection);
  }
  // Read the original server response before the page can use it and leave the document.
  session.on('Fetch.requestPaused', onReply);
  const apiResponse = { urlPattern: `${origin}/api/*`, requestStage: 'Response' as const };
  await session.send('Fetch.enable', { patterns: [apiResponse] });
}

export async function navigateWithReplies(page: Page, url: string,
  replies: Promise<void>[]): Promise<void> {
  // Report any failed inspection before starting the next journey step.
  await page.waitForLoadState('networkidle');
  await Promise.all(replies);
  await page.goto(url);
}

export async function finishBrowserReplies(browser: Browser,
  replies: Promise<void>[]): Promise<void> {
  // Check pending inspections and any that arrive during shutdown before recording PASS.
  await Promise.all(replies);
  await browser.close();
  await Promise.all(replies);
}
