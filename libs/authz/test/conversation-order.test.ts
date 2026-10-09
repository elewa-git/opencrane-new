import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { pgDb } from '@opencrane/projections';
import { dispatch, HandlerRuntime, provisionDispatcher } from '@opencrane/handlers';
import { createStore, memberAuthorisation, rebuildMembers } from '../src/index.ts';
import { databases, openfga, until } from './services.ts';

async function ordersConversationJobs() {
  const storage = await databases();
  const fga = await openfga();
  const nats = await natsFixture();
  const stop = new AbortController();
  const authorisation = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  let releaseCreation = () => undefined;
  const creationGate = new Promise<void>(function captureRelease(resolve) {
    releaseCreation = resolve;
  });
  let creationStarted = false;
  async function delayedCreation(saved: EventEnvelope) {
    if (saved.type === 'conversation.created') {
      creationStarted = true;
      await creationGate;
    }
    await authorisation.handler.handle(saved, pgDb(storage.queue));
  }
  const handler = { ...authorisation.handler, handle: delayedCreation };
  const runtime = new HandlerRuntime({ db: pgDb(storage.queue), silo: 'test', handlers: [handler],
    logger: createLogger('conversation-order'), expireInSeconds: 10 });
  let task: Promise<void> | undefined;
  function record(id: string, subject: string, type: string, data: unknown) {
    return { ...event(id, subject, type), data };
  }
  try {
    const member = event('member', 'member-alice');
    const created = record('created', 'conversation-chat', 'conversation.created', {
      conversationId: 'chat', createdBy: 'alice', assistantId: 'assistant', mode: 'agent_session',
    });
    const removed = record('removed', 'participation-chat', 'participant.removed', {
      conversationId: 'chat', participantId: 'alice', removedBy: 'alice',
    });
    expect((await nats.store.append({ event: member, expectedSequence: 0 })).status).toBe('appended');
    expect((await nats.store.append({ event: created, expectedSequence: 0 })).status).toBe('appended');
    // Store the future subject unchanged so this test first exercises the old worker's routing.
    await nats.connection.request('ev.participation.chat', JSON.stringify(removed));
    await runtime.start();
    await provisionDispatcher(nats.connection);
    task = dispatch(nats.dispatcherConnection, runtime, stop.signal);
    function ignoreStop() { return undefined; }
    void task.catch(ignoreStop);
    await runtime.work();
    function started() { return creationStarted; }
    await until(started);
    function queuedRemoval() {
      return storage.queue.query("SELECT singleton_key FROM pgboss.job WHERE data->>'id' = 'removed'");
    }
    async function removalQueued() { return (await queuedRemoval()).rows.length === 1; }
    await until(removalQueued);
    expect((await queuedRemoval()).rows).toEqual([{ singleton_key: 'conversation-chat' }]);
    expect(await authorisation.applied('removed')).toBe(false);
    releaseCreation();
    function removalApplied() { return authorisation.applied('removed'); }
    await until(removalApplied);
    expect(await authorisation.applied('created')).toBe(true);
    expect((await authorisation.conversation('alice', 'chat', 'read')).allowed).toBe(false);
    await authorisation.handler.handle(created, pgDb(storage.queue));
    expect((await authorisation.conversation('alice', 'chat', 'read')).allowed).toBe(false);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader,
      { verifyAgainst: authorisation.binding });
    expect(rebuilt.verified).toBe(true);

    const group = record('group', 'conversation-group', 'conversation.created', {
      conversationId: 'group', createdBy: 'alice', mode: 'group', participantIds: ['alice', 'bob'],
    });
    await authorisation.handler.handle(group, pgDb(storage.queue));
    expect((await authorisation.conversation('alice', 'group', 'manage_participants')).allowed)
      .toBe(true);
    expect((await authorisation.conversation('bob', 'group', 'read')).allowed).toBe(false);
    const bob = event('bob', 'member-bob');
    await authorisation.handler.handle(bob, pgDb(storage.queue));
    expect((await authorisation.conversation('bob', 'group', 'read')).allowed).toBe(true);
    expect((await authorisation.conversation('bob', 'group', 'manage_participants')).allowed)
      .toBe(false);
    const wrongSubject = { ...removed, id: 'wrong', subject: 'participation-other' };
    await expect(authorisation.handler.handle(wrongSubject, pgDb(storage.queue)))
      .rejects.toThrow('Conversation subject mismatch');
    const foreign = { ...removed, id: 'foreign', silo: 'other' };
    await expect(authorisation.handler.handle(foreign, pgDb(storage.queue))).rejects.toThrow();
  } finally {
    releaseCreation();
    stop.abort();
    await task?.catch(function ignoreStop() { return undefined; });
    await runtime.stop();
    await nats.close();
    await fga.close();
    await storage.close();
  }
}
it('keeps a delayed creation before removal and projects explicit creator and participant rights',
  ordersConversationJobs, 45_000);
