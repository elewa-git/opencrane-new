import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { finishBrowserReplies, navigateWithReplies } from './provider-navigation.ts';

function serve(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === '/api/check') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"result":"safe"}');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  if (request.url === '/') {
    response.end('<script>fetch("/api/check")</script>');
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
