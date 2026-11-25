import type { Browser, CDPSession, Page, Request } from 'playwright';

type HttpReply = { url: string; status: number };

type RequestStarted = {
  requestId: string;
  request: { method: string; url: string };
  redirectResponse?: HttpReply;
};

type ApiRequest = {
  method: string;
  completion: PromiseWithResolvers<void>;
  body?: PromiseWithResolvers<string>;
};

type WatchedPage = {
  apiRoot: string;
  session: CDPSession;
  pending: Map<string, ApiRequest>;
  pageRequests: Map<Request, PromiseWithResolvers<void>>;
};

const watchedPages = new WeakMap<Page, WatchedPage>();

function responseName(response: HttpReply, method: string): string {
  const url = URL.parse(response.url);
  const approvalsPath = /^\/api\/conversations\/[^/]+\/approvals$/u;
  if (method === 'GET' && url && approvalsPath.test(url.pathname)) {
    return 'the chat approvals GET response';
  }
  return 'an API response';
}

export class BrowserReplyFailure extends Error {
  constructor(response: HttpReply, method: string, cause: unknown) {
    const target = responseName(response, method);
    super(`Chromium could not read the body of ${target} (HTTP ${response.status}).`, { cause });
  }
}

async function inspectResponseBody(method: string, response: HttpReply, body: Promise<string>,
  inspect: (body: string) => void): Promise<void> {
  let content: string;
  try {
    content = await body;
  } catch (cause) {
    throw new BrowserReplyFailure(response, method, cause);
  }
  inspect(content);
}

async function readBody(session: CDPSession, requestId: string): Promise<string> {
  const reply = await session.send('Network.getResponseBody', { requestId });
  if (reply.base64Encoded) {
    return Buffer.from(reply.body, 'base64').toString('utf8');
  }
  return reply.body;
}

function stopRequest(request: ApiRequest, cause: Error): void {
  request.body?.reject(cause);
  request.completion.resolve();
}

function trackPageRequests(page: Page, apiRoot: string): WatchedPage['pageRequests'] {
  const pending = new Map<Request, PromiseWithResolvers<void>>();
  function started(request: Request): void {
    if (request.url().startsWith(apiRoot)) {
      pending.set(request, Promise.withResolvers<void>());
    }
  }
  function finished(request: Request): void {
    const completion = pending.get(request);
    pending.delete(request);
    completion?.resolve();
  }
  page.on('request', started);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  return pending;
}

function listenForReplies(watcher: WatchedPage, replies: Promise<void>[],
  inspect: (body: string) => void): void {
  const { apiRoot, session, pending } = watcher;
  function recordReply(request: ApiRequest, response: HttpReply): void {
    const body = Promise.withResolvers<string>();
    request.body = body;
    const inspection = inspectResponseBody(request.method, response, body.promise, inspect);
    void Promise.allSettled([inspection]);
    replies.push(inspection);
  }
  function requestStarted(event: RequestStarted): void {
    const previous = pending.get(event.requestId);
    if (previous && event.redirectResponse) {
      // Record redirects too. Chromium reuses the request ID and drops the earlier body.
      recordReply(previous, event.redirectResponse);
      stopRequest(previous, new Error('Chromium did not keep the redirect body'));
      pending.delete(event.requestId);
    }
    if (event.request.url.startsWith(apiRoot)) {
      const completion = Promise.withResolvers<void>();
      pending.set(event.requestId, { method: event.request.method, completion });
    }
  }
  function responseReceived(event: { requestId: string; response: HttpReply }): void {
    if (!event.response.url.startsWith(apiRoot)) return;
    let request = pending.get(event.requestId);
    if (!request) {
      const completion = Promise.withResolvers<void>();
      request = { method: '', completion };
      pending.set(event.requestId, request);
    }
    recordReply(request, event.response);
  }
  function requestFinished(event: { requestId: string }): void {
    const request = pending.get(event.requestId);
    if (!request) return;
    pending.delete(event.requestId);
    request.completion.resolve();
    if (request.body) request.body.resolve(readBody(session, event.requestId));
  }
  function requestFailed(event: { requestId: string; errorText: string }): void {
    const request = pending.get(event.requestId);
    if (!request) return;
    pending.delete(event.requestId);
    stopRequest(request, new Error(event.errorText));
  }
  function sessionClosed(): void {
    const cause = new Error('Chromium closed before the reply finished');
    for (const request of pending.values()) stopRequest(request, cause);
    pending.clear();
  }
  session.on('Network.requestWillBeSent', requestStarted);
  session.on('Network.responseReceived', responseReceived);
  session.on('Network.loadingFinished', requestFinished);
  session.on('Network.loadingFailed', requestFailed);
  session.on('close', sessionClosed);
}

export async function watchBrowserReplies(page: Page, origin: string, replies: Promise<void>[],
  inspect: (body: string) => void): Promise<void> {
  const apiRoot = `${origin}/api/`;
  const context = page.context();
  const session = await context.newCDPSession(page);
  const pending = new Map<string, ApiRequest>();
  // Observe page requests in Playwright too. Its actions can return before the other session
  // that reads the body reports the request, even after the server has received it.
  const pageRequests = trackPageRequests(page, apiRoot);
  const watcher = { apiRoot, session, pending, pageRequests };
  listenForReplies(watcher, replies, inspect);
  // Keep bodies available when the page immediately navigates after a reply.
  await session.send('Network.configureDurableMessages', {
    maxTotalBufferSize: 32 * 1024 * 1024,
    maxResourceBufferSize: 8 * 1024 * 1024,
  });
  await session.send('Network.enable');
  watchedPages.set(page, watcher);
}

export async function navigateWithReplies(page: Page, url: string,
  replies: Promise<void>[]): Promise<void> {
  await waitForBrowserReplies(page, replies);
  await page.goto(url);
}

function requestFinished(request: ApiRequest): Promise<void> {
  return request.completion.promise;
}

function pageRequestFinished(completion: PromiseWithResolvers<void>): Promise<void> {
  return completion.promise;
}

async function waitForIdle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  // A settled page can start API requests after the browser first reports it idle.
  const watcher = watchedPages.get(page);
  if (!watcher || watcher.pending.size + watcher.pageRequests.size === 0) return;
  const { pending, pageRequests } = watcher;
  const limit = Promise.withResolvers<void>();
  function timedOut() {
    limit.reject(new Error('Browser API requests did not finish before navigation'));
  }
  const timer = setTimeout(timedOut, 30_000);
  try {
    while (pending.size + pageRequests.size > 0) {
      const requests = Array.from(pending.values(), requestFinished);
      const pageCompletions = Array.from(pageRequests.values(), pageRequestFinished);
      const completions = [...requests, ...pageCompletions];
      await Promise.race([Promise.all(completions), limit.promise]);
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
  if (watcher) {
    // Stop new polls while replies already on their way finish.
    const urls = [`${watcher.apiRoot}*`];
    await watcher.session.send('Network.setBlockedURLs', { urls });
  }
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
