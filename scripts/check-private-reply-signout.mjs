import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';

const origin = 'https://private-reply.opencrane.test';
const build = resolve('apps/web/dist/private-reply/browser');
const execute = promisify(execFile);
const buildOptions = { timeout: 180_000, env: { ...process.env, NO_COLOR: '1' } };
const buildArguments = ['-n', '10', 'npm', 'run', 'build', '-w', 'apps/web', '--',
  '--configuration=development', '--output-path=dist/private-reply'];
await execute('nice', buildArguments, buildOptions);

const identity = { version: 1, topic: 'conversation', conversationId: 'chat',
  turnId: 'turn', threadId: 'thread', generation: 7, inputGeneration: 'input' };
const reply = { ...identity, type: 'private_reply',
  data: { text: 'Synthetic private reply', turnId: 'turn' } };
const ready = { version: 1, topic: 'conversation', conversationId: 'chat',
  type: 'ready', position: 0, generation: 1 };
const started = { ...ready, type: 'event', position: 1,
  row: { id: 'start', position: 1, type: 'agent.turn_started',
    data: { turnId: 'turn' }, time: '2026-11-05T00:00:00Z' } };
const lateStart = { ...started, position: 2,
  row: { ...started.row, id: 'next', position: 2, data: { turnId: 'next' } } };
const lateReply = { ...reply, turnId: 'next',
  data: { text: 'Late private reply', turnId: 'next' } };

// Inspect the public state in a development build until private reply display exists.
function privateText() {
  const element = document.querySelector('oc-workspace');
  const component = globalThis.ng?.getComponent(element);
  return component?.chat.privateReply()?.data.text ?? null;
}
function connected() {
  const element = document.querySelector('oc-workspace');
  return globalThis.ng?.getComponent(element)?.chat.connected() ?? false;
}

async function sessionFixture(context, broadcast) {
  let authenticated = true;
  let authenticationReads = 0;
  let logoutPosts = 0;
  let socket;
  let socketClosed = false;
  let markSubscribed;
  function waitForSubscription(resolveSubscription) {
    markSubscribed = resolveSubscription;
  }
  const subscriptionReady = new Promise(waitForSubscription);
  async function serve(route) {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === '/auth/me') {
      authenticationReads += 1;
      body = { authenticated, user: { name: 'Alex' } };
    } else if (path === '/auth/logout') {
      assert.equal(route.request().method(), 'POST');
      authenticated = false;
      logoutPosts += 1;
      const response = { contentType: 'text/plain', body: 'Signed out' };
      await route.fulfill(response);
      return;
    } else if (path === '/api/chat') {
      body = { memberId: 'me', assistantId: 'assistant' };
    } else if (path === '/api/conversations') {
      const conversation = { conversationId: 'chat', assistantId: 'assistant',
        mode: 'agent_session', createdBy: 'me', createdAt: '2026-11-05T00:00:00Z' };
      body = { rows: [conversation] };
    } else if (path.startsWith('/api/')) {
      body = { rows: [], position: 0, generation: 1, computerState: 'ready' };
    } else {
      await serveWebBuild(route, build);
      return;
    }
    const response = { contentType: 'application/json', body: JSON.stringify(body) };
    await route.fulfill(response);
  }
  function acceptSocket(connection) {
    socket = connection;
    function subscribe() {
      connection.send(JSON.stringify(ready));
      markSubscribed();
    }
    function close() {
      socketClosed = true;
    }
    connection.onMessage(subscribe);
    connection.onClose(close);
  }
  function disableBroadcast() {
    // Exercise return-time checking when a sleeping tab misses the notification.
    globalThis.BroadcastChannel = undefined;
  }
  await context.route('**/*', serve);
  await context.routeWebSocket('**/ws', acceptSocket);
  if (!broadcast) await context.addInitScript(disableBroadcast);
  function send(frame) {
    socket.send(JSON.stringify(frame));
  }
  function assertSignedOut() {
    assert.equal(logoutPosts, 1);
    assert.equal(socketClosed, true);
  }
  function readCount() {
    return authenticationReads;
  }
  return { subscriptionReady, send, assertSignedOut, readCount };
}

async function scenario(browser, broadcast) {
  const context = await browser.newContext();
  const fixture = await sessionFixture(context, broadcast);
  try {
    const tabA = await context.newPage();
    await tabA.goto(`${origin}/workspace?conversation=chat`);
    await tabA.waitForFunction(connected);
    await fixture.subscriptionReady;
    fixture.send(started);
    fixture.send(reply);
    // Playwright serialises one function at a time, so supply its helper explicitly.
    await tabA.waitForFunction(`(${privateText})() === 'Synthetic private reply'`);
    const tabB = await context.newPage();
    await tabB.goto(`${origin}/`);
    await tabB.bringToFront();
    const signOut = tabB.getByRole('button', { name: 'Sign out', exact: true });
    await signOut.click();
    await tabB.getByText('Signed out', { exact: true }).waitFor();
    if (broadcast) {
      await tabA.waitForFunction(`(${privateText})() === null`);
      assert.equal(await tabA.evaluate(connected), false);
    }
    const readsBeforeReturn = fixture.readCount();
    await tabA.bringToFront();
    // Headless Chromium does not consistently emit focus when switching pages.
    function returnToTab() {
      window.dispatchEvent(new Event('focus'));
    }
    await tabA.evaluate(returnToTab);
    await tabA.waitForFunction(`(${privateText})() === null`);
    assert.equal(await tabA.evaluate(connected), false);
    if (!broadcast) assert(fixture.readCount() > readsBeforeReturn);
    fixture.assertSignedOut();
    fixture.send(lateStart);
    fixture.send(lateReply);
    assert.equal(await tabA.evaluate(privateText), null);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
try {
  await scenario(browser, true);
  await scenario(browser, false);
  console.log('PASS two-tab sign-out and return-time session checks in Chromium');
} finally {
  await browser.close();
}
