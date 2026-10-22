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
  const before = await store.head(accessSubject);
  const feed = watchFeed(removed, conversationId);
  try {
    await removed.reload();
    await removed.getByText(oldMessage, { exact: true }).waitFor();
    await feed.ready;
    const deadline = Date.now() + 10_000;
    const saved = observeSavedRemoval();
    async function observeSavedRemoval() {
      while (Date.now() < deadline) {
        const position = await store.head(accessSubject);
        if (position > before) {
          const row = await store.readEvent(position);
          assert.equal(row.event.type, 'participant.removed');
          assert.equal(row.event.subject, accessSubject);
          return;
        }
        await delay(20);
      }
      throw new Error('The removal was not saved');
    }
    async function removalSaved() {
      await saved;
    }
    async function pageCleared() {
      while (Date.now() < deadline) {
        const transcript = await removed.locator('.transcript').innerText();
        if (transcript.includes('You no longer have access') && !transcript.includes(oldMessage)) {
          return;
        }
        await delay(20);
      }
      throw new Error('The removed page did not clear');
    }
    async function ownerList() {
      const list = owner.locator('.participant-list').first();
      while (Date.now() < deadline) {
        if (await list.getByText(name, { exact: true }).count() === 0) return;
        await delay(50);
      }
      throw new Error('The Owner list did not update');
    }
    async function historyRefused() {
      await readUntilRefused(`${path}/messages?since=0`);
    }
    async function fileRefused() {
      await readUntilRefused(`${path}/files`);
    }
    async function readUntilRefused(apiPath: string) {
      while (Date.now() < deadline) {
        const response = await removed.request.get(`${origin}${apiPath}`, { timeout: 2_000 });
        const status = response.status();
        await response.dispose();
        if (status === 403) return;
        assert.equal(status, 200, 'Only an access refusal proves removal');
        await delay(20);
      }
      throw new Error('The removed person could still read');
    }
    function isRemoval(response: Response) {
      return response.url() === `${origin}${path}/participants`
        && response.request().method() === 'POST';
    }
    async function accept() {
      const responsePending = owner.waitForResponse(isRemoval, { timeout: 10_000 });
      const row = owner.locator('.participant-list').first().locator('li').filter({ hasText: name });
      const click = row.getByRole('button', { name: 'Remove', exact: true }).click();
      const response = await responsePending;
      const acceptedAt = Date.now();
      assert.equal(response.status(), 200, 'The server accepted the removal');
      await click;
      return acceptedAt;
    }
    const observations = {
      removalSaved, accessStreamUpdated: removalSaved, liveFeedClosed: feed.closed,
      pageCleared, historyRefused, fileRefused, ownerList,
    };
    const result = await measureRemoval(accept, observations);
    const hops: Record<string, number | string> = {};
    for (const [hop, elapsed] of Object.entries(result.hops)) {
      hops[`${hop}Ms`] = elapsed ?? 'NOT RUN';
    }
    return { cleared: result.passed, hops };
  } finally {
    feed.stop();
  }
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
