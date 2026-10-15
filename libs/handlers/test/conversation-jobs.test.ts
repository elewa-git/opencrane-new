import { expect, it } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import { HandlerRuntime, registerHandler, upgradeHandlers } from '../src/index.ts';
import { handlerJobKey } from '../src/job-key.ts';
import { fixture, until } from './helpers.ts';
import { createLogger } from '@opencrane/observability';
import type { EventEnvelope } from '@opencrane/events';

async function acceptsQueuedLegacyJobs() {
  const storage = await fixture();
  const applied: string[] = [];
  function handle(saved: EventEnvelope) {
    applied.push(saved.id);
    return Promise.resolve();
  }
  const handler = registerHandler('update-openfga', handle);
  const options = { db: storage.db, silo: 'test', handlers: [handler],
    logger: createLogger('old-conversation-jobs') };
  const runtime = new HandlerRuntime(options);
  try {
    await runtime.start();
    const creation = { ...event('creation', 'conversation-chat', 'conversation.created'),
      data: { conversationId: 'chat', createdBy: 'alice', assistantId: 'assistant' } };
    const added = { ...event('added', 'conversation-chat', 'participant.added'),
      data: { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' } };
    const removed = { ...event('removed', 'conversation-chat', 'participant.removed'),
      data: { conversationId: 'chat', participantId: 'bob', removedBy: 'alice' } };
    const records = [creation, added, removed];
    for (const saved of records) {
      expect(handlerJobKey('update-openfga', saved)).toBe('conversation-chat');
      const queued = await runtime.boss.send(handler.name, saved, { singletonKey: saved.subject });
      expect(queued).not.toBeNull();
    }
    const newAdded = { ...added, subject: 'participation-chat' };
    expect(handlerJobKey('update-openfga', newAdded)).toBe('conversation-chat');
    expect(handlerJobKey('update-members', newAdded)).toBe('participation-chat');
    // Start after the old jobs are queued, as an upgraded worker would.
    await runtime.work();
    function allApplied() {
      return Promise.resolve(applied.length === records.length);
    }
    await until(allApplied);
    expect(applied).toEqual(['creation', 'added', 'removed']);
    expect(await runtime.deadLetters('update-openfga')).toEqual([]);
  } finally {
    await runtime.stop();
    await storage.close();
  }
}
it('uses the conversation key for both forms and accepts jobs queued before the upgrade',
  acceptsQueuedLegacyJobs);

async function queuesHistoricalConversationJobs() {
  const fixtureOptions = { idleTimeoutMillis: 50 };
  const storage = await fixture(fixtureOptions);
  const applied: string[] = [];
  function handle(saved: EventEnvelope) {
    applied.push(saved.id);
    return Promise.resolve();
  }
  const handler = registerHandler('update-openfga', handle);
  const runtime = await storage.runtime([handler]);
  try {
    const creation = { ...event('creation', 'conversation-chat', 'conversation.created'),
      data: { conversationId: 'chat', createdBy: 'alice', mode: 'group',
        participantIds: ['alice', 'bob'] } };
    const removed = { ...event('removed', 'participation-chat', 'participant.removed'),
      data: { conversationId: 'chat', participantId: 'bob', removedBy: 'alice' } };
    const added = { ...event('added', 'participation-chat', 'participant.added'),
      data: { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' } };
    await storage.nats.seed([creation, removed, added]);
    await storage.db.query(`CREATE TABLE handler_dispatcher (
      id INTEGER PRIMARY KEY, silo TEXT, manifest TEXT, sequence BIGINT)`);
    await storage.db.query("INSERT INTO handler_dispatcher VALUES (1, 'test', '[]', 3)");
    await runtime.stop();
    await storage.waitForConnectionsClosed();
    await upgradeHandlers(runtime, storage.nats.store);
    const jobs = await storage.db.query(
      "SELECT data->>'id' AS event_id, singleton_key FROM pgboss.job ORDER BY created_on",
    );
    const expected = [
      { event_id: 'creation', singleton_key: 'conversation-chat' },
      { event_id: 'removed', singleton_key: 'conversation-chat' },
      { event_id: 'added', singleton_key: 'conversation-chat' },
    ];
    expect(jobs.rows).toEqual(expected);
    await runtime.start();
    await runtime.work();
    function allApplied() {
      return Promise.resolve(applied.length === expected.length);
    }
    await until(allApplied);
    expect(applied).toEqual(['creation', 'removed', 'added']);
    expect(await runtime.deadLetters('update-openfga')).toEqual([]);
  } finally {
    await storage.close();
  }
}
it('backfills creation, removal and re-addition on one conversation key in saved order',
  queuesHistoricalConversationJobs);

async function ordersGatewayPublications() {
  const storage = await fixture();
  const applied: string[] = [];
  function handle(saved: EventEnvelope) {
    applied.push(saved.id);
    return Promise.resolve();
  }
  const handler = registerHandler('prepare-gateway-configuration', handle);
  const runtime = await storage.runtime([handler]);
  try {
    const alpha = { ...event('alpha', 'mcp-alpha', 'mcp.server_published'),
      data: { serverId: 'alpha', publishedBy: 'admin' } };
    const bravo = { ...event('bravo', 'mcp-bravo', 'mcp.server_published'),
      data: { serverId: 'bravo', publishedBy: 'admin' } };
    expect(handlerJobKey(handler.name, alpha)).toBe('gateway-config-test');
    expect(handlerJobKey(handler.name, bravo)).toBe('gateway-config-test');
    await runtime.enqueue(handler, alpha, storage.db);
    await runtime.enqueue(handler, bravo, storage.db);
    await runtime.work();
    function bothApplied() {
      return Promise.resolve(applied.length === 2);
    }
    await until(bothApplied);
    expect(applied).toEqual(['alpha', 'bravo']);
  } finally {
    await storage.close();
  }
}
it('runs publications from different servers in one silo order', ordersGatewayPublications);
