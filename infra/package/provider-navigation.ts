import type { Browser, CDPSession, Page, Request } from 'playwright';

type PausedReply = { requestId: string; responseStatusCode?: number };
const apiRequests = new WeakMap<Page, Map<Request, PromiseWithResolvers<void>>>();

function watchApiRequests(page: Page, apiRoot: string): void {
  const pending = new Map<Request, PromiseWithResolvers<void>>();
  apiRequests.set(page, pending);
  function started(request: Request) {
    if (request.url().startsWith(apiRoot)) pending.set(request, Promise.withResolvers<void>());
  }
  function finished(request: Request) {
    const completion = pending.get(request);
    pending.delete(request);
    completion?.resolve();
  }
  page.on('request', started);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
}

async function inspectResponseBody(session: CDPSession, request: { requestId: string },
  inspect: (body: string) => void): Promise<void> {
  const response = await session.send('Fetch.getResponseBody', request);
  const body = response.base64Encoded
    ? Buffer.from(response.body, 'base64').toString('utf8')
    : response.body;
  inspect(body);
}

function continuationWasCancelled(error: unknown) {
  return error instanceof Error && error.message ===
    'cdpSession.send: Protocol error (Fetch.continueResponse): Invalid InterceptionId.';
}

async function inspectPausedReply(session: CDPSession, reply: PausedReply,
  inspect: (body: string) => void): Promise<void> {
  const request = { requestId: reply.requestId };
  if (reply.responseStatusCode === undefined) {
    // A transport failure has no HTTP body to inspect.
    await session.send('Fetch.continueRequest', request);
    return;
  }
  const [inspection] = await Promise.allSettled([inspectResponseBody(session, request, inspect)]);
  const [continuation] = await Promise.allSettled([session.send('Fetch.continueResponse', request)]);
  // Chromium can cancel a paused response after its body has been checked.
  // A cancelled continuation must never replace a body-read or inspection failure.
  if (inspection.status === 'rejected') throw inspection.reason;
  if (continuation.status === 'rejected' && !continuationWasCancelled(continuation.reason)) {
    throw continuation.reason;
  }
}

export async function watchBrowserReplies(page: Page, origin: string, replies: Promise<void>[],
  inspect: (body: string) => void): Promise<void> {
  const apiRoot = `${origin}/api/`;
  watchApiRequests(page, apiRoot);
  const context = page.context();
  const session = await context.newCDPSession(page);
  function onReply(reply: PausedReply): void {
    const inspection = inspectPausedReply(session, reply, inspect);
    void Promise.allSettled([inspection]);
    replies.push(inspection);
  }
  // Read the original server response before the page can use it and leave the document.
  session.on('Fetch.requestPaused', onReply);
  const apiResponse = { urlPattern: `${apiRoot}*`, requestStage: 'Response' as const };
  await session.send('Fetch.enable', { patterns: [apiResponse] });
}

export async function navigateWithReplies(page: Page, url: string,
  replies: Promise<void>[]): Promise<void> {
  await waitForBrowserReplies(page, replies);
  await page.goto(url);
}

function requestFinished(completion: PromiseWithResolvers<void>) {
  return completion.promise;
}

async function waitForIdle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  // A settled page can start API requests after the browser first reports it idle.
  const pending = apiRequests.get(page);
  if (!pending?.size) return;
  const limit = Promise.withResolvers<void>();
  function timedOut() {
    limit.reject(new Error('Browser API requests did not finish before navigation'));
  }
  const timer = setTimeout(timedOut, 30_000);
  try {
    while (pending.size > 0) {
      const replies = Array.from(pending.values(), requestFinished);
      await Promise.race([Promise.all(replies), limit.promise]);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForBrowserReplies(page: Page, replies: Promise<void>[]): Promise<void> {
  // Report any failed inspection before starting the next journey step.
  await waitForIdle(page);
  await Promise.all(replies);
}

export async function finishBrowserReplies(browser: Browser,
  replies: Promise<void>[]): Promise<void> {
  const idlePages = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) idlePages.push(waitForIdle(page));
  }
  await Promise.all(idlePages);
  // Check pending inspections and any that arrive during shutdown before recording PASS.
  await Promise.all(replies);
  await browser.close();
  await Promise.all(replies);
}
