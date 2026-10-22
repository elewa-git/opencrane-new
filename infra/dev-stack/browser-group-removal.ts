/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Request, Response, WebSocket } from 'playwright';
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

export async function checkGroupRemoval(options: RemovalOptions): Promise<{
  cleared: boolean; hops: Record<string, number | string>;
}> {
  const { owner, removed, origin, conversationId, name, oldMessage, store } = options;
  const path = `/api/conversations/${conversationId}`;
  const accessSubject = `participation-${conversationId}`;
  const participantLists = owner.locator('.participant-list');
  const participantList = participantLists.first();
  const selectedName = participantList.getByText(name, { exact: true });
  await selectedName.waitFor();
  const before = await store.head(accessSubject);
  const feed = watchFeed(removed, conversationId);
  try {
    await removed.reload();
    const earlierMessage = removed.getByText(oldMessage, { exact: true });
    await earlierMessage.waitFor();
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
    const accept = acceptRemoval.bind(null, owner, `${origin}${path}/participants`,
      name, feed.removing);
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
  const transcriptRegion = page.locator('.transcript');
  const messageRows = page.locator('.transcript article.message');
  while (Date.now() < deadline) {
    const transcript = await transcriptRegion.innerText();
    const messages = await messageRows.count();
    if (transcript.includes('You no longer have access')
      && !transcript.includes(oldMessage) && messages === 0) {
      return;
    }
    await delay(20);
  }
  throw new Error('The removed page did not clear');
}

async function observeOwnerList(page: Page, name: string, deadline: number) {
  const lists = page.locator('.participant-list');
  const list = lists.first();
  const selectedName = list.getByText(name, { exact: true });
  while (Date.now() < deadline) {
    if (await selectedName.count() === 0) {
      return;
    }
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
    if (status === 403) {
      return;
    }
    assert.equal(status, 200, 'Only an access refusal proves removal');
    await delay(20);
  }
  throw new Error('The removed person could still read');
}

async function acceptRemoval(page: Page, url: string, name: string, removing: () => void) {
  let sentAt: number | undefined;
  function requestSent(request: Request) {
    if (request.url() !== url || request.method() !== 'POST') {
      return;
    }
    // Start before the server can save removal, and select the connection open now.
    sentAt = Date.now();
    removing();
  }
  function isRemoval(response: Response) {
    return response.url() === url && response.request().method() === 'POST';
  }
  page.on('request', requestSent);
  try {
    const responsePending = page.waitForResponse(isRemoval, { timeout: 10_000 });
    const lists = page.locator('.participant-list');
    const list = lists.first();
    const rows = list.locator('li');
    const row = rows.filter({ hasText: name });
    const removeButton = row.getByRole('button', { name: 'Remove', exact: true });
    const click = removeButton.click();
    const response = await responsePending;
    const acceptedAt = Date.now();
    await click;
    assert.equal(response.status(), 200, 'The server accepted the removal');
    assert(sentAt !== undefined, 'The browser must send the removal request');
    return { sentAt, acceptedAt };
  } finally {
    page.off('request', requestSent);
  }
}

type FeedConnection = {
  closed: PromiseWithResolvers<number>;
  closedAt: number | undefined;
};

function watchFeed(page: Page, conversationId: string) {
  const ready = Promise.withResolvers<void>();
  const selected = Promise.withResolvers<FeedConnection>();
  const stopWatchingSockets: (() => void)[] = [];
  let current: FeedConnection | undefined;
  let removingConnection: FeedConnection | undefined;
  function unavailable() {
    const error = new Error('The removed person had no ready live feed, or it did not close');
    ready.reject(error);
    selected.reject(error);
    removingConnection?.closed.reject(error);
  }
  const timeout = setTimeout(unavailable, 20_000);
  // Handle the timeout even if setup fails before the measurement starts.
  void selected.promise.catch(ignoreUnavailable);
  void ready.promise.catch(ignoreUnavailable);
  function ignoreUnavailable() {}
  function observeSocket(socket: WebSocket) {
    if (new URL(socket.url()).pathname !== '/ws') {
      return;
    }
    const connection: FeedConnection = {
      closed: Promise.withResolvers<number>(), closedAt: undefined,
    };
    void connection.closed.promise.catch(ignoreUnavailable);
    function received(frame: { payload: string | Buffer }) {
      const raw = JSON.parse(frame.payload.toString()) as Record<string, unknown>;
      if (raw['conversationId'] !== conversationId || raw['type'] !== 'ready') {
        return;
      }
      current = connection;
      ready.resolve();
    }
    function didClose() {
      connection.closedAt = Date.now();
      connection.closed.resolve(connection.closedAt);
    }
    socket.on('framereceived', received);
    socket.on('close', didClose);
    function stopWatching() {
      socket.off('framereceived', received);
      socket.off('close', didClose);
    }
    stopWatchingSockets.push(stopWatching);
  }
  page.on('websocket', observeSocket);
  function removing() {
    if (!current || current.closedAt !== undefined) {
      selected.reject(new Error('The removed person must have an open live feed'));
      return;
    }
    removingConnection = current;
    selected.resolve(current);
  }
  async function waitClosed() {
    const connection = await selected.promise;
    return connection.closed.promise;
  }
  function stop() {
    clearTimeout(timeout);
    page.off('websocket', observeSocket);
    for (const stopWatching of stopWatchingSockets) {
      stopWatching();
    }
  }
  return { ready: ready.promise, closed: waitClosed, removing, stop };
}
