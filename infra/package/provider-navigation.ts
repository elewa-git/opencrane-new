import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright';

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
  closed: boolean;
  pending: Map<string, ApiRequest>;
  pageRequests: Map<Request, PromiseWithResolvers<void>>;
};

const watchedPages = new WeakMap<Page, WatchedPage>();

export type ShutdownStep = 'draining the collector' | 'closing pages' | 'closing the context'
  | 'closing the browser';

type ShutdownFailure = (step: ShutdownStep, error: unknown) => Promise<void>;

export async function runShutdownStep(step: ShutdownStep, action: () => Promise<void>,
  recordFailure?: ShutdownFailure): Promise<void> {
  try {
    await action();
  } catch (error) {
    await recordFailure?.(step, error);
    throw error;
  }
}

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
  function closed(): void {
    for (const completion of pending.values()) completion.resolve();
    pending.clear();
  }
  page.on('request', started);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  page.on('close', closed);
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
    watcher.closed = true;
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
  const watcher = { apiRoot, session, pending, pageRequests, closed: false };
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

async function waitForPendingRequests(watcher: WatchedPage): Promise<void> {
  const { pending, pageRequests } = watcher;
  while (pending.size + pageRequests.size > 0) {
    const requests = Array.from(pending.values(), requestFinished);
    const pageCompletions = Array.from(pageRequests.values(), pageRequestFinished);
    const completions = [...requests, ...pageCompletions];
    await Promise.all(completions);
  }
}

async function waitForCompletion(completion: Promise<void>, message: string): Promise<void> {
  const limit = Promise.withResolvers<void>();
  function timedOut(): void {
    limit.reject(new Error(message));
  }
  const timer = setTimeout(timedOut, 30_000);
  try {
    await Promise.race([completion, limit.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForIdle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  // A settled page can start API requests after the browser first reports it idle.
  const watcher = watchedPages.get(page);
  if (!watcher) return;
  const completion = waitForPendingRequests(watcher);
  await waitForCompletion(completion, 'Browser API requests did not finish before navigation');
}

export async function waitForBrowserReplies(page: Page, replies: Promise<void>[]): Promise<void> {
  // Report any failed inspection before starting the next journey step.
  await waitForIdle(page);
  await Promise.all(replies);
}

async function stopNewRequests(page: Page): Promise<void> {
  const watcher = watchedPages.get(page);
  if (watcher) {
    // Stop new polls while replies already on their way finish.
    const urls = [`${watcher.apiRoot}*`];
    await watcher.session.send('Network.setBlockedURLs', { urls });
  }
}

async function inspectReplies(replies: Promise<void>[]): Promise<void> {
  let checked = 0;
  while (checked < replies.length) {
    const batch = replies.slice(checked);
    checked += batch.length;
    await Promise.all(batch);
  }
}

async function closeWatchedPage(page: Page): Promise<void> {
  const watcher = watchedPages.get(page);
  if (watcher?.closed) throw new Error('Chromium stopped reporting API replies before page close');
  await page.close();
}

export async function finishBrowserReplies(browser: Browser,
  replies: Promise<void>[], recordFailure?: ShutdownFailure): Promise<void> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap(browserContextPages);
  async function drainBeforeClose(): Promise<void> {
    for (const page of pages) await stopNewRequests(page);
    const inspection = inspectReplies(replies);
    await waitForCompletion(inspection, 'Chromium did not finish replies it had already received');
  }
  async function drainAfterClose(): Promise<void> {
    // Keep watching until Chromium closes each page. Only then can a request with
    // no observed reply be left out. Any reply announced during close still counts.
    for (const page of pages) {
      const watcher = watchedPages.get(page);
      if (watcher && (!page.isClosed() || !watcher.closed)) {
        throw new Error('Chromium did not confirm the end of API reply collection');
      }
    }
    await inspectReplies(replies);
  }
  await runShutdownStep('draining the collector', drainBeforeClose, recordFailure);
  for (const page of pages) {
    const closePage = closeWatchedPage.bind(undefined, page);
    await runShutdownStep('closing pages', closePage, recordFailure);
  }
  for (const context of contexts) {
    const closeContext = context.close.bind(context);
    await runShutdownStep('closing the context', closeContext, recordFailure);
  }
  const closeBrowser = browser.close.bind(browser);
  await runShutdownStep('closing the browser', closeBrowser, recordFailure);
  await runShutdownStep('draining the collector', drainAfterClose, recordFailure);
}

function browserContextPages(context: BrowserContext): Page[] {
  return context.pages();
}
