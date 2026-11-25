/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type CDPSession, type Page } from 'playwright';
import { postJourneyCommand, readJourneyApi } from '../dev-stack/browser-api.ts';
import { assertNoBrowserDisclosure } from './provider-disclosure.ts';
import { answer } from '../dev-stack/real-model-journey.ts';
import { providerFailure } from './provider-failure.ts';
import { finishBrowserReplies, navigateWithReplies, watchBrowserReplies }
  from './provider-navigation.ts';
import type { ExpectedReply } from './provider-reply-coverage.ts';

function serve(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === '/api/check' ||
      request.url === '/api/conversations/fixture/approvals?key=private-query') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"result":"safe"}');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  if (request.url === '/') {
    response.end('<script>fetch("/api/check")</script>');
  } else if (request.url === '/redirect-after-check') {
    response.end(`<script>
      async function go() {
        const response = await fetch('/api/check');
        const data = await response.json();
        if (data.result === 'safe') location.assign('/next');
      }
      go();
    </script>`);
  } else if (request.url === '/charged-reply') {
    response.end(`<section class="transcript" aria-busy="false"></section>
      <textarea aria-label="Message your agent"></textarea>
      <script>
        function showReply() {
          document.querySelector('.transcript').innerHTML =
            '<article aria-label="Agent reply"><div class="prose">Recorded fixture reply.</div>' +
            '<p class="turn-status">Done</p></article>';
        }
        if (sessionStorage.getItem('answered')) showReply();
        document.querySelector('textarea').addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            sessionStorage.setItem('answered', 'true');
            showReply();
          }
        });
      </script>`);
  } else {
    response.end('<p>Next page</p>');
  }
}

async function keepsResponseBodies(): Promise<void> {
  const server = createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    function isCheck(response: { url(): string }): boolean {
      return response.url() === `${origin}/api/check`;
    }
    const received = page.waitForResponse(isCheck);
    await page.goto(origin);
    const response = await received;
    await response.finished();
    let checked = false;
    function holdInspection(resolve: () => void): void {
      setTimeout(resolve, 200);
    }
    const ready = new Promise<void>(holdInspection);
    async function inspect(): Promise<void> {
      await ready;
      assert.equal(await response.text(), '{"result":"safe"}');
      checked = true;
    }
    const inspection = inspect();
    const outcome = Promise.allSettled([inspection]);
    await navigateWithReplies(page, `${origin}/next`, [inspection]);
    const [result] = await outcome;
    if (result?.status === 'rejected') throw result.reason;
    assert.equal(checked, true);
    assert.equal(page.url(), `${origin}/next`);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('navigation waits for API disclosure inspection before discarding the old response body',
  keepsResponseBodies);

async function waitsBeforeReloadingReply() {
  const server = createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/charged-reply`);
    await page.evaluate(() => { document.body.dataset['beforeReload'] = 'yes'; });
    let inspections = 0;
    async function inspect() {
      const beforeReload = await page.locator('body').getAttribute('data-before-reload');
      assert.equal(beforeReload, 'yes', 'The original document must still be open');
      await page.getByRole('article', { name: 'Agent reply' }).waitFor();
      inspections++;
    }
    await answer(page, 'Show the charged reply.', [/Recorded fixture reply/u], inspect);
    assert.equal(inspections, 1, 'The browser must inspect its responses before reloading');
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('the charged reply waits for disclosure inspection before reloading', waitsBeforeReloadingReply);

async function waitsForRequestsStartedAfterLoad() {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function respond(request: IncomingMessage, response: ServerResponse) {
    if (request.url !== '/api/held') {
      serve(request, response);
      return;
    }
    received.resolve();
    await release.promise;
    response.end('held response');
  }
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const replies: Promise<void>[] = [];
    const bodies: string[] = [];
    function inspect(body: string) { bodies.push(body); }
    await watchBrowserReplies(page, origin, replies, inspect);
    await page.goto(`${origin}/idle`);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => { void fetch('/api/held'); });
    await received.promise;
    const navigation = navigateWithReplies(page, `${origin}/next`, replies);
    function navigated() { return 'navigation'; }
    const finishedFirst = await Promise.race([navigation.then(navigated),
      delay(250, 'still waiting')]);
    release.resolve();
    await navigation;
    assert.equal(finishedFirst, 'still waiting', 'Stay on the old page while its request is in flight');
    assert.deepEqual(bodies, ['held response']);
  } finally {
    release.resolve();
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('navigation waits for API requests started after the page had finished loading',
  waitsForRequestsStartedAfterLoad);

async function preservesInspectionFailures(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<p>Original page</p>');
    const inspection = Promise.reject(new Error('API disclosure check failed'));
    const handled = Promise.allSettled([inspection]);
    const navigation = navigateWithReplies(page, 'data:text/html,Next', [inspection]);
    await assert.rejects(navigation, /API disclosure check failed/u);
    await handled;
    assert.equal(page.url(), 'about:blank');
  } finally {
    await browser.close();
  }
}

test('a failed API disclosure inspection refuses navigation and remains a failed journey',
  preservesInspectionFailures);

async function preservesLateInspectionFailures(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const replies: Promise<void>[] = [];
  function lateInspection(): void {
    const inspection = Promise.reject(new Error('Late API disclosure check failed'));
    void Promise.allSettled([inspection]);
    replies.push(inspection);
  }
  browser.on('disconnected', lateInspection);
  const completion = finishBrowserReplies(browser, replies);
  await assert.rejects(completion, /Late API disclosure check failed/u);
}

test('an inspection failure arriving during browser shutdown still refuses a journey PASS',
  preservesLateInspectionFailures);

function startApprovalPoll(path: string): void {
  function pollStopped(): void {}
  const poll = fetch(path);
  void poll.catch(pollStopped);
}

async function drainsBeforeClosingWithAPoll(): Promise<void> {
  const reachedServer = Promise.withResolvers<void>();
  const pollPath = '/api/conversations/fixture/approvals';
  let polls = 0;
  function respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.url !== pollPath) {
      serve(request, response);
      return;
    }
    polls++;
    reachedServer.resolve();
    response.end('late approval poll');
  }
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const close = page.close.bind(page);
    const pollUrl = `${origin}${pollPath}`;
    const replies: Promise<void>[] = [];
    const bodies: string[] = [];
    function inspect(body: string) { bodies.push(body); }
    await watchBrowserReplies(page, origin, replies, inspect);
    const initialReply = page.waitForResponse(`${origin}/api/check`);
    await page.goto(origin);
    await initialReply;
    async function closeWithPoll(): Promise<void> {
      function isApprovalPoll(request: { url(): string }): boolean {
        return request.url() === pollUrl;
      }
      const rejected = page.waitForEvent('requestfailed', isApprovalPoll);
      await page.evaluate(startApprovalPoll, pollPath);
      await Promise.race([reachedServer.promise, rejected]);
      await close();
    }
    page.close = closeWithPoll;
    await finishBrowserReplies(browser, replies);
    assert.equal(polls, 0, 'A closing page cannot start another request at the server');
    assert.deepEqual(bodies, ['{"result":"safe"}']);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('shutdown drains inspected replies before a new approval poll can reach the server',
  drainsBeforeClosingWithAPoll);

async function closesWithReplyStillAtServer(): Promise<void> {
  const reachedServer = Promise.withResolvers<void>();
  const connectionClosed = Promise.withResolvers<boolean>();
  function respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.url !== '/api/held') {
      serve(request, response);
      return;
    }
    function closed(): void {
      connectionClosed.resolve(response.headersSent);
    }
    response.once('close', closed);
    reachedServer.resolve();
  }
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const replies: Promise<void>[] = [];
    const bodies: string[] = [];
    function inspect(body: string): void {
      bodies.push(body);
    }
    await watchBrowserReplies(page, origin, replies, inspect);
    await page.goto(`${origin}/idle`);
    await page.waitForLoadState('networkidle');
    await page.evaluate(startApprovalPoll, '/api/held');
    await reachedServer.promise;

    async function receiveBody(): Promise<string> {
      const response = await fetch('/api/check');
      return response.text();
    }
    assert.equal(await page.evaluate(receiveBody), '{"result":"safe"}');
    await finishBrowserReplies(browser, replies);
    assert.equal(browser.isConnected(), false);
    assert.equal(await connectionClosed.promise, false, 'The held reply sent no headers');
    assert.deepEqual(bodies, ['{"result":"safe"}']);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('shutdown checks the completed reply and closes a request that received no response',
  closesWithReplyStillAtServer);

function loseBodyReads(page: Page, command: 'Fetch.getResponseBody' | 'Network.getResponseBody',
  error: Error): void {
  const context = page.context();
  const openSession = context.newCDPSession.bind(context);
  async function openSessionWithBodyLoss(target: Parameters<typeof openSession>[0]) {
    const session = await openSession(target);
    const send = session.send.bind(session);
    const sendWithBodyLoss: CDPSession['send'] = async function (method, parameters) {
      if (method === command) throw error;
      return send(method, parameters);
    };
    session.send = sendWithBodyLoss;
    return session;
  }
  context.newCDPSession = openSessionWithBodyLoss;
}

async function collectsBodyWithoutHoldingTheReply(): Promise<void> {
  const server = createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const lostBody = new Error('Fetch.getResponseBody lost the response while Chromium held it');
    loseBodyReads(page, 'Fetch.getResponseBody', lostBody);
    const replies: Promise<void>[] = [];
    const bodies: string[] = [];
    function inspect(body: string): void {
      bodies.push(body);
    }
    await watchBrowserReplies(page, origin, replies, inspect);
    const moved = page.waitForURL(`${origin}/next`);
    await page.goto(`${origin}/redirect-after-check`);
    await moved;
    await finishBrowserReplies(browser, replies);
    assert.deepEqual(bodies, ['{"result":"safe"}']);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('the page receives its reply and the collector checks it when a paused read would lose it',
  collectsBodyWithoutHoldingTheReply);

async function refusesUnreadableDeliveredBody(): Promise<void> {
  const server = createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const bodyError = new Error('Chromium lost the body with private exception content');
    const replies: Promise<void>[] = [];
    const approvalPath = '/api/conversations/fixture/approvals?key=private-query';
    loseBodyReads(page, 'Network.getResponseBody', bodyError);
    function inspect(): never {
      throw new Error('There is no body to inspect');
    }
    await watchBrowserReplies(page, origin, replies, inspect);
    await page.goto(`${origin}/idle`);
    async function readApproval(path: string): Promise<string> {
      const response = await fetch(path);
      return response.text();
    }
    const displayedBody = await page.evaluate(readApproval, approvalPath);
    assert.equal(displayedBody, '{"result":"safe"}');
    function recordedFailure(error: unknown): boolean {
      assert(error instanceof Error);
      assert.equal(error.cause, bodyError);
      const step = {
        check: 'finish API disclosure inspections',
        detail: 'Every reply must be checked.',
      };
      const result = providerFailure(step, error);
      assert.equal(result.result, 'FAIL');
      assert.equal(result.detail, 'Chromium could not read the body of the chat approvals GET '
        + 'response (HTTP 200). Every reply must be checked.');
      assert.doesNotMatch(JSON.stringify(result), /private|fixture/u);
      return true;
    }
    function cannotWrite(): Promise<never> {
      return Promise.reject(new Error('The private log cannot be written'));
    }
    await assert.rejects(finishBrowserReplies(browser, replies, cannotWrite), recordedFailure);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('an unreadable browser reply fails the disclosure check even when the page received it',
  refusesUnreadableDeliveredBody);

const disclosureMarker = 'synthetic-fixture-credential';

type ReplyFixture = {
  page: Page;
  browser: import('playwright').Browser;
  origin: string;
  replies: Promise<void>[];
};

async function withMarkedReply(run: (fixture: ReplyFixture) => Promise<void>): Promise<void> {
  function respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.url === '/api/marked') {
      request.resume();
      response.end(JSON.stringify({ value: disclosureMarker }));
      return;
    }
    serve(request, response);
  }
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const replies: Promise<void>[] = [];
    await run({ page, browser, origin, replies });
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

function omitReplyNotification(page: Page, url: string, omitStart: boolean): void {
  const context = page.context();
  const newSession = context.newCDPSession.bind(context);
  async function openSession(target: Parameters<typeof newSession>[0]) {
    const session = await newSession(target);
    const subscribe = session.on.bind(session);
    type Notification = { request?: { url: string }; response?: { url: string } };
    function on(event: string | symbol, listener: (value: never) => void) {
      function deliver(value: Notification): void {
        const missingStart = omitStart && value.request?.url === url;
        if (!missingStart && value.response?.url !== url) {
          Reflect.apply(listener, undefined, [value]);
        }
      }
      const filtering = event === 'Network.responseReceived' || event === 'Network.requestWillBeSent';
      Reflect.apply(subscribe, session, [event, filtering ? deliver : listener]);
      return session;
    }
    session.on = on;
    return session;
  }
  context.newCDPSession = openSession;
}

const inspectMarkedBody = assertNoBrowserDisclosure.bind(undefined, [disclosureMarker]);

async function readMarkedBody() {
  const safe = await fetch('/api/check');
  await safe.text();
  const marked = await fetch('/api/marked');
  return marked.text();
}

type ReplyFault = 'marked' | 'omitted response' | 'omitted request and response';

async function assertMarkedPageRefused(fixture: ReplyFixture, fault: ReplyFault): Promise<void> {
  const { page, browser, origin, replies } = fixture;
  if (fault !== 'marked') {
    omitReplyNotification(page, `${origin}/api/marked`, fault === 'omitted request and response');
  }
  await watchBrowserReplies(page, origin, replies, inspectMarkedBody);
  await page.goto(`${origin}/idle`);
  const body = await page.evaluate(readMarkedBody);
  assert(body.includes(disclosureMarker), 'The page received the marked body');
  const expected = fault === 'marked' ? /API reply disclosed a key/u
    : /delivered API reply was not inspected/u;
  await assert.rejects(finishBrowserReplies(browser, replies), expected);
}

async function missingPageReply(fixture: ReplyFixture): Promise<void> {
  await assertMarkedPageRefused(fixture, 'omitted response');
}

async function disclosedPageReply(fixture: ReplyFixture): Promise<void> {
  await assertMarkedPageRefused(fixture, 'marked');
}

const testMissingPageReply = withMarkedReply.bind(undefined, missingPageReply);
test('shutdown refuses a delivered page reply missing from Chromium inspection',
  testMissingPageReply);

async function missingPageRequestAndReply(fixture: ReplyFixture): Promise<void> {
  await assertMarkedPageRefused(fixture, 'omitted request and response');
}

const testMissingPageRequestAndReply = withMarkedReply.bind(undefined, missingPageRequestAndReply);
test('Playwright delivery still counts when Chromium misses the request and its response',
  testMissingPageRequestAndReply);


const testDisclosedPageReply = withMarkedReply.bind(undefined, disclosedPageReply);
test('the disclosure check refuses a marked page reply', testDisclosedPageReply);

async function disclosedDirectRead({ page, origin, replies }: ReplyFixture): Promise<void> {
  await watchBrowserReplies(page, origin, replies, inspectMarkedBody);
  await assert.rejects(readJourneyApi(page, `${origin}/api/marked`), /API reply disclosed a key/u);
}

const testDisclosedDirectRead = withMarkedReply.bind(undefined, disclosedDirectRead);
test('a direct read checks for disclosure before returning the reply', testDisclosedDirectRead);

async function disclosedDirectCommand({ page, origin, replies }: ReplyFixture): Promise<void> {
  await watchBrowserReplies(page, origin, replies, inspectMarkedBody);
  const body = { fixture: true };
  const command = postJourneyCommand(page, origin, '/api/marked', body);
  await assert.rejects(command, /API reply disclosed a key/u);
}

const testDisclosedDirectCommand = withMarkedReply.bind(undefined, disclosedDirectCommand);
test('a direct command checks for disclosure before returning the reply', testDisclosedDirectCommand);

async function missingDirectOperation(fixture: ReplyFixture): Promise<void> {
  const { page, browser, origin, replies } = fixture;
  await watchBrowserReplies(page, origin, replies, inspectMarkedBody);
  await page.goto(origin);
  const operation: ExpectedReply = { transport: 'direct', method: 'GET', path: /^\/api\/check$/u,
    label: 'fixture status read' };
  const coverage = new Map([[page, [operation]]]);
  const shutdown = finishBrowserReplies(browser, replies, undefined, coverage);
  await assert.rejects(shutdown, /Missing inspected replies for fixture status read/u);
}

const testMissingDirectOperation = withMarkedReply.bind(undefined, missingDirectOperation);
test('an inspected page reply cannot stand in for a required direct read',
  testMissingDirectOperation);

async function missingPageOperation(fixture: ReplyFixture): Promise<void> {
  const { page, browser, origin, replies } = fixture;
  await watchBrowserReplies(page, origin, replies, inspectMarkedBody);
  const direct = await readJourneyApi(page, `${origin}/api/check`);
  assert.equal(direct.status(), 200);
  const operation: ExpectedReply = { transport: 'page', method: 'GET', path: /^\/api\/check$/u,
    label: 'fixture page' };
  const coverage = new Map([[page, [operation]]]);
  const shutdown = finishBrowserReplies(browser, replies, undefined, coverage);
  await assert.rejects(shutdown, /Missing inspected replies for fixture page/u);
}

const testMissingPageOperation = withMarkedReply.bind(undefined, missingPageOperation);
test('an inspected direct read cannot stand in for a required page reply', testMissingPageOperation);

async function coversPageAndDirectReplies(fixture: ReplyFixture): Promise<void> {
  const { page, browser, origin, replies } = fixture;
  await watchBrowserReplies(page, origin, replies, inspectMarkedBody);
  const pageReply = page.waitForResponse(`${origin}/api/check`);
  await page.goto(origin);
  await pageReply;
  const directReply = await readJourneyApi(page, `${origin}/api/check`);
  assert.equal(directReply.status(), 200);
  const pageOperation: ExpectedReply = { transport: 'page', method: 'GET',
    path: /^\/api\/check$/u, label: 'fixture page' };
  const directOperation: ExpectedReply = { ...pageOperation, transport: 'direct',
    label: 'fixture status read' };
  const coverage = new Map([[page, [pageOperation, directOperation]]]);
  await finishBrowserReplies(browser, replies, undefined, coverage);
}

const testCoveredOperations = withMarkedReply.bind(undefined, coversPageAndDirectReplies);
test('shutdown accepts the expected page and direct replies after both inspections',
  testCoveredOperations);
