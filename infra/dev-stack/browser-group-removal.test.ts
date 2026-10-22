import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { checkGroupRemoval } from './browser-group-removal.ts';

type FixtureOptions = { clearAt: number; closeAt: number; replaceSocket?: boolean };

function removalFixture(options: FixtureOptions) {
  const owner = new EventEmitter();
  const removed = new EventEmitter();
  const replacement = new EventEmitter();
  const response = Promise.withResolvers<unknown>();
  const request = Promise.withResolvers<unknown>();
  const origin = 'http://fixture.invalid';
  const conversationId = 'fixture-chat';
  const participantUrl = `${origin}/api/conversations/${conversationId}/participants`;
  let savedPositionReads = 0;
  function url() {
    return participantUrl;
  }
  function method() {
    return 'POST';
  }
  const removalRequest = { url, method };
  function responseRequest() {
    return removalRequest;
  }
  function status() {
    return 200;
  }
  const removalResponse = { url, request: responseRequest, status };
  function socketUrl() {
    return 'ws://fixture.invalid/ws';
  }
  Object.assign(replacement, { url: socketUrl });
  const readyFrame = { payload: JSON.stringify({ conversationId, type: 'ready' }) };
  async function reload() {
    if (options.replaceSocket) {
      const previous = new EventEmitter();
      Object.assign(previous, { url: socketUrl });
      removed.emit('websocket', previous);
      previous.emit('framereceived', readyFrame);
      previous.emit('close');
    }
    removed.emit('websocket', replacement);
    replacement.emit('framereceived', readyFrame);
  }
  function receiveResponse() {
    response.resolve(removalResponse);
  }
  function closeReplacement() {
    replacement.emit('close');
  }
  async function click() {
    owner.emit('request', removalRequest);
    request.resolve(removalRequest);
    setTimeout(receiveResponse, 700);
    setTimeout(closeReplacement, options.closeAt);
  }
  async function waitForResponse(predicate: (value: unknown) => boolean) {
    const value = await response.promise;
    assert.equal(predicate(value), true);
    return value;
  }
  async function waitForRequest(predicate: (value: unknown) => boolean) {
    const value = await request.promise;
    assert.equal(predicate(value), true);
    return value;
  }
  async function waitFor() {}
  async function count() {
    return 0;
  }
  async function innerText() {
    await new Promise(function wait(resolve) {
      setTimeout(resolve, options.clearAt);
    });
    return 'You no longer have access';
  }
  const participantName = { waitFor, count };
  const button = { click };
  function getByText() {
    return participantName;
  }
  function getByRole() {
    return button;
  }
  const row = { getByRole };
  function filter() {
    return row;
  }
  const rows = { filter };
  function listLocator() {
    return rows;
  }
  const list = { getByText, locator: listLocator };
  function first() {
    return list;
  }
  function ownerLocator() {
    return { first };
  }
  function removedLocator(selector: string) {
    if (selector === '.transcript') {
      return { innerText };
    }
    return { count: messageCount };
  }
  async function messageCount() {
    return 0;
  }
  function refusedStatus() {
    return 403;
  }
  async function dispose() {}
  async function get() {
    return { status: refusedStatus, dispose };
  }
  Object.assign(owner, { locator: ownerLocator, waitForResponse, waitForRequest });
  Object.assign(removed, { reload, getByText, locator: removedLocator, request: { get } });
  async function head() {
    savedPositionReads += 1;
    return savedPositionReads === 1 ? 0 : 1;
  }
  async function readEvent() {
    return { event: { type: 'participant.removed', subject: `participation-${conversationId}` } };
  }
  const store = { head, readEvent } as unknown as EventStore;
  return {
    owner: owner as unknown as Page, removed: removed as unknown as Page,
    origin, conversationId, name: 'Colleague', oldMessage: 'Earlier group message', store,
  };
}

async function advance(context: TestContext, milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 20) {
    context.mock.timers.tick(20);
    await setImmediate();
  }
}

async function includesResponseDelayInTheBound(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const fixture = removalFixture({ clearAt: 2_400, closeAt: 100 });
  const pending = checkGroupRemoval(fixture);
  await setImmediate();
  await advance(context, 2_600);
  const result = await pending;
  assert.equal(result.cleared, false,
    'Save at 0 ms, response at 700 ms and page clear at 2,400 ms must fail');
  assert.equal(result.hops['removalAcceptedMs'], 700);
  assert.equal(result.hops['pageClearedMs'], 2_400);
}

test('counts from the removal request even when the response arrives later',
  includesResponseDelayInTheBound);

async function waitsForTheSocketOpenAtRemoval(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const fixture = removalFixture({ clearAt: 100, closeAt: 1_200, replaceSocket: true });
  let finished = false;
  async function run() {
    const result = await checkGroupRemoval(fixture);
    finished = true;
    return result;
  }
  const pending = run();
  await setImmediate();
  await advance(context, 1_000);
  const finishedBeforeReplacementClosed = finished;
  await advance(context, 400);
  const result = await pending;
  assert.equal(finishedBeforeReplacementClosed, false,
    'Closing the earlier socket must not complete the replacement observation');
  assert.equal(result.hops['liveFeedClosedMs'], 1_200);
  assert.equal(result.cleared, true);
}

test('waits for the replacement socket and keeps its observed close time',
  waitsForTheSocketOpenAtRemoval);
