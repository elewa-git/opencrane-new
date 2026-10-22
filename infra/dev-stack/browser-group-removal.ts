/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Response, WebSocket } from 'playwright';
import type { EventStore } from '@opencrane/event-store';
import { measureRemoval } from './group-removal-timing.ts';

type RemovalOptions = {
  owner: Page;
  removed: Page;
  origin: string;
  conversationId: string;
  name: string;
  oldMessage: string;
  store: EventStore;
};

export async function checkGroupRemoval(options: RemovalOptions) {
  const { owner, removed, origin, conversationId, name, oldMessage, store } = options;
  const path = `/api/conversations/${conversationId}`;
  const accessSubject = `participation-${conversationId}`;
  const participantList = owner.locator('.participant-list').first();
  const selectedName = participantList.getByText(name, { exact: true });
  await selectedName.waitFor();
  const before = await store.head(accessSubject);
  const feed = watchFeed(removed, conversationId);
  try {
    await removed.reload();
    await removed.getByText(oldMessage, { exact: true }).waitFor();
    await feed.ready;
    // Record the existing file refusal; this chat mode has no files to revoke.
    const beforeFiles = await removed.request.get(`${origin}${path}/files`);
    assert.equal(beforeFiles.status(), 403, 'People-only chats do not offer files');
    await beforeFiles.dispose();
    const deadline = Date.now() + 10_000;
    const saved = observeSavedRemoval(store, accessSubject, before, deadline);
    async function removalSaved() {
      await saved;
    }
    const pageCleared = observePageCleared.bind(null, removed, oldMessage, deadline);
    const ownerList = observeOwnerList.bind(null, owner, name, deadline);
    const historyUrl = `${origin}${path}/messages?since=0`;
    const historyRefused = readUntilRefused.bind(null, removed, historyUrl, deadline);
    const fileRefused = readUntilRefused.bind(null, removed, `${origin}${path}/files`, deadline);
    const accept = acceptRemoval.bind(null, owner, `${origin}${path}/participants`, name);
    const observations = {
      removalSaved, accessStreamUpdated: removalSaved, liveFeedClosed: feed.closed,
      pageCleared, historyRefused, fileRefused, ownerList,
    };
    const result = await measureRemoval(accept, observations);
    const hops: Record<string, number | string> = {};
    for (const [hop, elapsed] of Object.entries(result.hops)) {
      hops[`${hop}Ms`] = elapsed ?? 'NOT RUN';
    }
    return { cleared: result.passed, hops: { ...hops, fileAccessBeforeRemoval: 'refused' } };
  } finally {
    feed.stop();
  }
}

async function observeSavedRemoval(store: EventStore, subject: string,
  before: number, deadline: number) {
  while (Date.now() < deadline) {
    const position = await store.head(subject);
    if (position > before) {
      const row = await store.readEvent(position);
      assert.equal(row.event.type, 'participant.removed');
      assert.equal(row.event.subject, subject);
      return;
    }
    await delay(20);
  }
  throw new Error('The removal was not saved');
}

async function observePageCleared(page: Page, oldMessage: string, deadline: number) {
  while (Date.now() < deadline) {
    const transcript = await page.locator('.transcript').innerText();
    const messages = await page.locator('.transcript article.message').count();
    if (transcript.includes('You no longer have access')
      && !transcript.includes(oldMessage) && messages === 0) return;
    await delay(20);
  }
  throw new Error('The removed page did not clear');
}

async function observeOwnerList(page: Page, name: string, deadline: number) {
  const list = page.locator('.participant-list').first();
  while (Date.now() < deadline) {
    if (await list.getByText(name, { exact: true }).count() === 0) return;
    await delay(50);
  }
  throw new Error('The Owner list did not update');
}

async function readUntilRefused(page: Page, url: string, deadline: number,
  accepted: Promise<number>) {
  await accepted;
  while (Date.now() < deadline) {
    const response = await page.request.get(url, { timeout: 2_000 });
    const status = response.status();
    await response.dispose();
    if (status === 403) return;
    assert.equal(status, 200, 'Only an access refusal proves removal');
    await delay(20);
  }
  throw new Error('The removed person could still read');
}

async function acceptRemoval(page: Page, url: string, name: string) {
  function isRemoval(response: Response) {
    return response.url() === url && response.request().method() === 'POST';
  }
  const responsePending = page.waitForResponse(isRemoval, { timeout: 10_000 });
  const row = page.locator('.participant-list').first().locator('li').filter({ hasText: name });
  const click = row.getByRole('button', { name: 'Remove', exact: true }).click();
  const response = await responsePending;
  const acceptedAt = Date.now();
  assert.equal(response.status(), 200, 'The server accepted the removal');
  await click;
  return acceptedAt;
}

function watchFeed(page: Page, conversationId: string) {
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let subscribed = false;
  let closedAt: number | undefined;
  function unavailable() {
    ready.reject(new Error('The removed person had no ready live feed'));
    closed.reject(new Error('The removed live feed did not close'));
  }
  const timeout = setTimeout(unavailable, 20_000);
  // Handle the timeout even if setup fails before the measurement starts.
  void closed.promise.catch(ignoreUnavailable);
  void ready.promise.catch(ignoreUnavailable);
  function ignoreUnavailable() {}
  function observeSocket(socket: WebSocket) {
    if (new URL(socket.url()).pathname !== '/ws') return;
    let matches = false;
    function received(frame: { payload: string | Buffer }) {
      const raw = JSON.parse(frame.payload.toString()) as Record<string, unknown>;
      if (raw['conversationId'] !== conversationId || raw['type'] !== 'ready') return;
      matches = true;
      subscribed = true;
      ready.resolve();
    }
    function didClose() {
      if (!matches) return;
      closedAt = Date.now();
      closed.resolve();
    }
    socket.on('framereceived', received);
    socket.on('close', didClose);
  }
  page.on('websocket', observeSocket);
  async function waitClosed() {
    assert(subscribed, 'The removed person must have an open live feed');
    await closed.promise;
    assert(closedAt !== undefined);
  }
  function stop() {
    clearTimeout(timeout);
    page.off('websocket', observeSocket);
  }
  return { ready: ready.promise, closed: waitClosed, stop };
}
