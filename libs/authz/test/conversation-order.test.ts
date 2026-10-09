import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { pgDb } from '@opencrane/projections';
import { dispatch, HandlerRuntime, provisionDispatcher } from '@opencrane/handlers';
import { createStore, memberAuthorisation, rebuildMembers } from '../src/index.ts';
import { databases, openfga, until } from './services.ts';
import { objectId } from '../src/client.ts';

function participantId(_unused: unknown, index: number) {
  const memberId = `member_${index}`;
  return memberId.padEnd(200, 'x');
}

async function ordersConversationJobs() {
  const storage = await databases();
  const fga = await openfga();
  const nats = await natsFixture();
  const stop = new AbortController();
  const db = pgDb(storage.queue);
  const authorisation = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  let releaseCreation: () => void = () => undefined;
  function captureRelease(resolve: () => void) {
    releaseCreation = resolve;
  }
  const creationGate = new Promise<void>(captureRelease);
  let creationStarted = false;
  async function delayedCreation(saved: EventEnvelope) {
    if (saved.type === 'conversation.created') {
      creationStarted = true;
      await creationGate;
    }
    await authorisation.handler.handle(saved, db);
    if (saved.type === 'conversation.created') {
      expect((await authorisation.conversation('alice', 'chat', 'manage_participants')).allowed)
        .toBe(true);
      expect((await authorisation.conversation('bob', 'chat', 'read')).allowed).toBe(true);
      expect((await authorisation.conversation('bob', 'chat', 'manage_participants')).allowed)
        .toBe(false);
    }
  }
  const handler = { ...authorisation.handler, handle: delayedCreation };
  const runtimeOptions = { db, silo: 'test', handlers: [handler],
    logger: createLogger('conversation-order'), expireInSeconds: 10 };
  const runtime = new HandlerRuntime(runtimeOptions);
  let task: Promise<void> | undefined;
  function ignoreStop() {
    return undefined;
  }
  function record(id: string, subject: string, type: string, data: unknown) {
    return { ...event(id, subject, type), data };
  }
  try {
    const member = event('member', 'member-alice');
    const audience = Array.from({ length: 95 }, participantId);
    audience.push('alice', 'bob');
    const creationData = { conversationId: 'chat', createdBy: 'alice', mode: 'group',
      participantIds: audience };
    const created = record('created', 'conversation-chat', 'conversation.created', creationData);
    const oversizedAudience = audience.concat('one_more');
    const invalidGroups = [
      { ...creationData, assistantId: 'assistant' }, { ...creationData, payingGroupId: 'team' },
      { ...creationData, mode: 'agent_session', assistantId: 'assistant' },
      { ...creationData, participantIds: ['alice', 'alice'] },
      { ...creationData, participantIds: ['bob', 'carol'] },
      { ...creationData, participantIds: ['alice'] },
      { ...creationData, participantIds: oversizedAudience },
      { ...creationData, groupId: 'team' }, { ...creationData, groupSnapshotPosition: 12 },
      { ...creationData, groupId: 'team', groupSnapshotPosition: -1 },
      { ...creationData, groupId: 'team', groupSnapshotPosition: 1.5 },
      { ...creationData, conversationId: 'provider-reserved' },
      { ...creationData, participantIds: ['alice', 'bad.id'] },
      { ...creationData, participantIds: ['alice', 'b'.repeat(201)] },
      { ...creationData, groupId: 'c'.repeat(201), groupSnapshotPosition: 1 },
    ];
    for (const data of invalidGroups) {
      const invalid = { ...created, data };
      const command = { event: invalid, expectedSequence: 0 };
      expect((await nats.store.append(command)).status).toBe('rejected');
    }
    const removed = record('removed', 'participation-chat', 'participant.removed', {
      conversationId: 'chat', participantId: 'bob', removedBy: 'alice',
    });
    const bob = event('bob', 'member-bob');
    const records = [bob, member, created];
    for (const saved of records) {
      const command = { event: saved, expectedSequence: 0 };
      expect((await nats.store.append(command)).status).toBe('appended');
    }
    // Publish directly to prove routing also works for records saved before the upgrade.
    const rawRemoval = await nats.connection.request('ev.participation.chat', JSON.stringify(removed));
    expect(rawRemoval.json()).toMatchObject({ seq: 4 });
    await authorisation.handler.handle(member, db);
    await authorisation.handler.handle(bob, db);
    await runtime.start();
    await provisionDispatcher(nats.connection);
    task = dispatch(nats.dispatcherConnection, runtime, stop.signal);
    void task.catch(ignoreStop);
    await runtime.work();
    function started() {
      return creationStarted;
    }
    await until(started);
    function queuedRemoval() {
      return storage.queue.query("SELECT singleton_key FROM pgboss.job WHERE data->>'id' = 'removed'");
    }
    async function removalQueued() {
      const removalJobs = await queuedRemoval();
      return removalJobs.rows.length === 1;
    }
    await until(removalQueued);
    expect((await queuedRemoval()).rows).toEqual([{ singleton_key: 'conversation-chat' }]);
    expect(await authorisation.applied('removed')).toBe(false);
    releaseCreation();
    function removalApplied() {
      return authorisation.applied('removed');
    }
    await until(removalApplied);
    expect(await authorisation.applied('created')).toBe(true);
    expect((await authorisation.conversation('bob', 'chat', 'read')).allowed).toBe(false);
    await authorisation.handler.handle(created, db);
    expect((await authorisation.conversation('bob', 'chat', 'read')).allowed).toBe(false);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader,
      { verifyAgainst: authorisation.binding });
    expect(rebuilt.verified).toBe(true);

    expect((await authorisation.conversation('alice', 'chat', 'manage_participants')).allowed)
      .toBe(true);
    const lateGroup = record('late-group', 'conversation-late', 'conversation.created', {
      conversationId: 'late', createdBy: 'alice', mode: 'group',
      participantIds: ['alice', 'ext:jane'],
    });
    await authorisation.handler.handle(lateGroup, db);
    expect((await authorisation.conversation('ext:jane', 'late', 'read')).allowed).toBe(false);
    const jane = { ...event('jane', 'member-ext:jane'),
      data: { memberId: 'ext:jane', role: 'member' } };
    await authorisation.handler.handle(jane, db);
    expect((await authorisation.conversation('ext:jane', 'late', 'read')).allowed).toBe(true);
    expect((await authorisation.conversation('ext:jane', 'late', 'manage_participants')).allowed)
      .toBe(false);
    const fixedModes = [
      { conversationId: 'direct', mode: 'direct', createdBy: 'alice',
        participantIds: ['alice', 'bob'] },
      { conversationId: 'session', mode: 'agent_session', createdBy: 'alice',
        assistantId: 'assistant' },
    ];
    for (const data of fixedModes) {
      const fixed = record(data.conversationId, `conversation-${data.conversationId}`,
        'conversation.created', data);
      await authorisation.handler.handle(fixed, db);
      const url = `${authorisation.binding.apiUrl}/stores/${authorisation.binding.storeId}/read`;
      const target = objectId('conversation', 'test', data.conversationId);
      const query = { tuple_key: { relation: 'creator', object: target } };
      const response = await fetch(url, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) });
      expect(response.ok).toBe(true);
      const tuples: unknown = await response.json();
      expect(tuples).toEqual({ tuples: [] });
      expect((await authorisation.conversation('alice', data.conversationId,
        'manage_participants')).allowed).toBe(false);
    }
    const wrongSubject = { ...removed, id: 'wrong', subject: 'participation-other' };
    await expect(authorisation.handler.handle(wrongSubject, db))
      .rejects.toThrow('Conversation subject mismatch');
    const foreign = { ...removed, id: 'foreign', silo: 'other' };
    await expect(authorisation.handler.handle(foreign, db)).rejects.toThrow('Invalid authorisation event or silo');
  } finally {
    releaseCreation();
    stop.abort();
    await task?.catch(ignoreStop);
    await runtime.stop();
    await nats.close();
    await fga.close();
    await storage.close();
  }
}
it('keeps a delayed creation before removal and projects explicit creator and participant rights',
  ordersConversationJobs, 45_000);
