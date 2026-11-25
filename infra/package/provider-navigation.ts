import type { Browser, CDPSession, Page, Request } from 'playwright';

type PausedReply = {
  requestId: string;
  request: { method: string; url: string };
  responseStatusCode?: number;
  responseErrorReason?: string;
};

type WatchedPage = {
  pending: Map<Request, PromiseWithResolvers<void>>;
  stopNewRequests: () => Promise<void>;
};

const watchedPages = new WeakMap<Page, WatchedPage>();

function responseName(reply: PausedReply): string {
  const url = URL.parse(reply.request.url);
  const approvalsPath = /^\/api\/conversations\/[^/]+\/approvals$/u;
  if (reply.request.method === 'GET' && url && approvalsPath.test(url.pathname)) {
    return 'the chat approvals GET response';
  }
  return 'an API response';
}

export class BrowserReplyFailure extends Error {
  constructor(action: 'read the body of' | 'resume', reply: PausedReply, cause: unknown) {
    const target = responseName(reply);
    const options = { cause };
    super(`Chromium could not ${action} ${target} (HTTP ${reply.responseStatusCode}).`, options);
  }
}

function watchApiRequests(page: Page, apiRoot: string): WatchedPage['pending'] {
  const pending = new Map<Request, PromiseWithResolvers<void>>();
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
  return pending;
}

async function inspectResponseBody(session: CDPSession, reply: PausedReply,
  inspect: (body: string) => void): Promise<void> {
  let response;
  try {
    const request = { requestId: reply.requestId };
    response = await session.send('Fetch.getResponseBody', request);
  } catch (cause) {
    throw new BrowserReplyFailure('read the body of', reply, cause);
  }
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
    // Let Chromium report the transport failure when there was no HTTP response.
    await session.send('Fetch.continueRequest', request);
    return;
  }
  const [inspection] = await Promise.allSettled([inspectResponseBody(session, reply, inspect)]);
  const [continuation] = await Promise.allSettled([session.send('Fetch.continueResponse', request)]);
  // Chromium can cancel a paused response after its body has been checked.
  // A cancelled continuation must never replace a body-read or inspection failure.
  if (inspection.status === 'rejected') throw inspection.reason;
  if (continuation.status === 'rejected' && !continuationWasCancelled(continuation.reason)) {
    throw new BrowserReplyFailure('resume', reply, continuation.reason);
  }
}

export async function watchBrowserReplies(page: Page, origin: string, replies: Promise<void>[],
  inspect: (body: string) => void): Promise<void> {
  const apiRoot = `${origin}/api/`;
  const pending = watchApiRequests(page, apiRoot);
  const context = page.context();
  const session = await context.newCDPSession(page);
  const apiResponse = { urlPattern: `${apiRoot}*`, requestStage: 'Response' as const };
  const apiRequest = { urlPattern: `${apiRoot}*`, requestStage: 'Request' as const };
  async function stopNewRequests(): Promise<void> {
    const shutdownPatterns = { patterns: [apiRequest, apiResponse] };
    await session.send('Fetch.enable', shutdownPatterns);
  }
  async function handlePause(reply: PausedReply): Promise<void> {
    if (reply.responseStatusCode !== undefined || reply.responseErrorReason !== undefined) {
      await inspectPausedReply(session, reply, inspect);
      return;
    }
    // Refuse new requests before they reach the server once shutdown starts.
    const request = { requestId: reply.requestId, errorReason: 'Aborted' as const };
    await session.send('Fetch.failRequest', request);
  }
  function onReply(reply: PausedReply): void {
    const inspection = handlePause(reply);
    void Promise.allSettled([inspection]);
    replies.push(inspection);
  }
  // Read the original server response before the page can use it and leave the document.
  session.on('Fetch.requestPaused', onReply);
  const responsePattern = { patterns: [apiResponse] };
  await session.send('Fetch.enable', responsePattern);
  const watchedPage = { pending, stopNewRequests };
  watchedPages.set(page, watchedPage);
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
  const pending = watchedPages.get(page)?.pending;
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

async function drainPage(page: Page): Promise<void> {
  const watcher = watchedPages.get(page);
  await watcher?.stopNewRequests();
  await waitForIdle(page);
}

export async function finishBrowserReplies(browser: Browser,
  replies: Promise<void>[]): Promise<void> {
  const idlePages = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) idlePages.push(drainPage(page));
  }
  await Promise.all(idlePages);
  // Check pending inspections and any that arrive during shutdown before recording PASS.
  await Promise.all(replies);
  await browser.close();
  await Promise.all(replies);
}
