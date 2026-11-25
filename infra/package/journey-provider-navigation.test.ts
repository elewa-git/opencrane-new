/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page, type Response } from 'playwright';
import { answer } from '../dev-stack/real-model-journey.ts';
import { finishBrowserReplies, navigateWithReplies, watchBrowserReplies }
  from './provider-navigation.ts';

function serve(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === '/api/check') {
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

async function scansReplyBeforePageNavigation(): Promise<void> {
  const server = createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const moved = page.waitForURL(`${origin}/next`);
    const replies: Promise<void>[] = [];
    const bodies: string[] = [];
    function delayPassiveRead(response: Response): void {
      if (response.url() !== `${origin}/api/check`) return;
      const read = response.text.bind(response);
      // Let the page leave before the passive inspector tries to read Chromium's old handle.
      async function readAfterNavigation(): Promise<string> {
        await moved;
        return read();
      }
      response.text = readAfterNavigation;
    }
    function inspect(body: string): void {
      bodies.push(body);
    }
    page.on('response', delayPassiveRead);
    await watchBrowserReplies(page, origin, replies, inspect);
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

test('the browser collector scans API replies when the application immediately navigates',
  scansReplyBeforePageNavigation);

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

async function drainsBeforeClosingWithAPoll(): Promise<void> {
  const pausedPoll = Promise.withResolvers<void>();
  const pollPath = '/api/conversations/fixture/approvals';
  let polls = 0;
  function respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.url !== pollPath) {
      serve(request, response);
      return;
    }
    polls++;
    // Hold the reply open so closing Chromium during the inspection loses its body.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
  }
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const close = browser.close.bind(browser);
  try {
    const page = await browser.newPage();
    const context = page.context();
    const openSession = context.newCDPSession.bind(context);
    const pollUrl = `${origin}${pollPath}`;
    async function observeSession(target: Parameters<typeof openSession>[0]) {
      const session = await openSession(target);
      function responsePaused(event: { request: { url: string }; responseStatusCode?: number }) {
        if (event.request.url === pollUrl && event.responseStatusCode === 200) pausedPoll.resolve();
      }
      session.on('Fetch.requestPaused', responsePaused);
      return session;
    }
    context.newCDPSession = observeSession;
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
      await page.evaluate(path => {
        void fetch(path).catch(() => undefined);
      }, pollPath);
      await Promise.race([pausedPoll.promise, rejected]);
      await close();
    }
    browser.close = closeWithPoll;
    await finishBrowserReplies(browser, replies);
    assert.equal(polls, 0, 'A closing page cannot start another request at the server');
    assert.deepEqual(bodies, ['{"result":"safe"}']);
  } finally {
    await close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('shutdown drains inspected replies before a new approval poll can reach the server',
  drainsBeforeClosingWithAPoll);

const cancelledResponse = new Error(
  'cdpSession.send: Protocol error (Fetch.continueResponse): Invalid InterceptionId.');

async function pausedResponse(inspect: (body: string) => void, bodyError?: Error,
  continueError = cancelledResponse) {
  const events = new EventEmitter();
  async function send(method: string) {
    if (method === 'Fetch.enable') return;
    if (method === 'Fetch.getResponseBody') {
      if (bodyError) throw bodyError;
      return { body: 'inspection fixture', base64Encoded: false };
    }
    assert.equal(method, 'Fetch.continueResponse');
    throw continueError;
  }
  const session = { on: events.on.bind(events), send };
  async function newCDPSession() { return session; }
  function context() { return { newCDPSession }; }
  function on() {}
  const page = { on, context } as unknown as Page;
  const replies: Promise<void>[] = [];
  await watchBrowserReplies(page, 'http://fixture.invalid', replies, inspect);
  events.emit('Fetch.requestPaused', { requestId: 'response', responseStatusCode: 200 });
  assert.equal(replies.length, 1);
  await Promise.all(replies);
}

async function keepsInspectionWhenBrowserCancels() {
  const inspected: string[] = [];
  function record(body: string) { inspected.push(body); }
  await pausedResponse(record);
  assert.deepEqual(inspected, ['inspection fixture']);
  const missingBody = new Error('The browser could not supply the response body');
  await assert.rejects(pausedResponse(record, missingBody), missingBody);
  const failedInspection = new Error('A response failed inspection');
  function refuse() { throw failedInspection; }
  await assert.rejects(pausedResponse(refuse), failedInspection);
  const unexpectedContinuation = new Error('Unexpected continuation failure');
  await assert.rejects(pausedResponse(record, undefined, unexpectedContinuation),
    unexpectedContinuation);
}

test('a cancelled continuation preserves completed and failed inspections',
  keepsInspectionWhenBrowserCancels);
