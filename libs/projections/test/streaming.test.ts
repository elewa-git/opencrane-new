import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { EventEnvelope } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import { conversations, ProjectionRunner, readConversation, pgliteDb, type Db,
  type EventSource, type Query } from '../src/index.ts';
import { database } from './database.ts';

function saved(position: number, type: string, data: unknown): StoredEvent {
  const event: EventEnvelope = {
    id: `event-${position}`, commandId: `event-${position}`, type, data,
    subject: 'conversation-chat', silo: 'test', source: 'test', correlation: {},
    principal: { kind: 'system', id: 'test' }, time: '2026-10-21T12:00:00Z',
  };
  return { sequence: position, event };
}

function replyEvents(): StoredEvent[] {
  const events = [saved(1, 'conversation.created', {
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
  })];
  for (let index = 0; index < 448; index += 1) {
    events.push(saved(events.length + 1, 'agent.message_delta', {
      conversationId: 'chat', turnId: 'turn', messageId: 'reply',
      ciphertext: Buffer.from('a'.repeat(63)).toString('base64'), keyId: 'key:fixture', contentType: 'text',
    }));
  }
  events.push(saved(events.length + 1, 'agent.turn_failed', {
    conversationId: 'chat', turnId: 'turn', reason: 'interrupted',
  }));
  return events;
}

function sourceFor(events: StoredEvent[]): EventSource {
  function head() {
    return Promise.resolve(events.length);
  }
  async function* subscribe(from: number) {
    await Promise.resolve();
    for (const event of events) {
      if (event.sequence >= from) {
        yield event;
      }
    }
  }
  return { head, subscribe };
}

// Model the measured commit wait without a live stack or a provider call.
function delayedCommits(db: Db): Db {
  async function transaction<Result>(work: (tx: Query) => Promise<Result>): Promise<Result> {
    const result = await db.transaction(work);
    await delay(10);
    return result;
  }
  async function lock<Result>(name: string, work: (locked: Db) => Promise<Result>) {
    if (!db.lock) {
      return work(delayedCommits(db));
    }
    async function locked(connection: Db) {
      return work(delayedCommits(connection));
    }
    return db.lock(name, locked);
  }
  return { query: db.query.bind(db), transaction, lock };
}

async function projectsLongReply() {
  const engine = new PGlite();
  const storage = { db: pgliteDb(engine), close: engine.close.bind(engine) };
  const events = replyEvents();
  const logger = createLogger('streaming-test', { level: 'silent' });
  const runner = new ProjectionRunner(delayedCommits(storage.db), sourceFor(events), logger);
  try {
    await runner.initialise(conversations);
    const started = performance.now();
    await runner.run(conversations);
    const elapsed = performance.now() - started;
    const rows = [];
    let position = 0;
    while (position < events.length) {
      const page = await readConversation(storage.db, 'test', 'chat', position);
      rows.push(...page.rows);
      position = page.rows.at(-1)?.position ?? events.length;
    }
    expect(rows).toHaveLength(events.length);
    expect(rows.map(rowData)).toEqual(events.map(storedData));
    expect(rows.at(-1)?.type).toBe('agent.turn_failed');
    expect(await runner.checkpoint(conversations)).toBe(events.length);
    expect(elapsed).toBeLessThan(2000);
  } finally {
    await storage.close();
  }
}

it('projects a 28,224-character reply and its closure within two seconds', projectsLongReply, 120_000);

async function retriesFailedReplyBatch() {
  const storage = await database('pg');
  const events = replyEvents().slice(0, 70);
  let fail = true;
  const projection = { ...conversations, apply, applyReplies };
  async function applyReplies(tx: Query, batch: StoredEvent[]) {
    for (const stored of batch) {
      await apply(tx, stored.event, stored.sequence);
    }
  }
  async function apply(tx: Query, event: EventEnvelope, position: number) {
    await conversations.apply(tx, event, position);
    if (fail && position === 33) {
      throw new Error('Reply projection interrupted');
    }
  }
  const logger = createLogger('streaming-test', { level: 'silent' });
  const runner = new ProjectionRunner(storage.db, sourceFor(events), logger);
  try {
    await runner.initialise(projection);
    await expect(runner.run(projection)).rejects.toThrow('Reply projection interrupted');
    expect(await runner.checkpoint(projection)).toBe(1);
    expect((await readConversation(storage.db, 'test', 'chat')).rows).toHaveLength(1);
    const receipts = await storage.db.query('SELECT event_id FROM projection_events');
    expect(receipts.rows).toEqual([{ event_id: 'event-1' }]);
    fail = false;
    await runner.run(projection);
    expect(await runner.checkpoint(projection)).toBe(70);
    expect((await readConversation(storage.db, 'test', 'chat')).rows).toHaveLength(70);
  } finally {
    await storage.close();
  }
}

it('rolls back a failed reply batch with its receipts and resumes all its text',
  retriesFailedReplyBatch, 30_000);

async function duplicateReplyBatches() {
  const storage = await database('pg');
  const events = replyEvents().slice(0, 70);
  const original = events[1]!.event;
  events[2] = { sequence: 3, event: original };
  events[67] = { sequence: 68, event: original };
  const logger = createLogger('streaming-test', { level: 'silent' });
  const source = sourceFor(events);
  const first = new ProjectionRunner(storage.db, source, logger);
  const second = new ProjectionRunner(storage.db, source, logger);
  try {
    await first.initialise(conversations);
    await Promise.all([first.run(conversations), second.run(conversations)]);
    const feed = await readConversation(storage.db, 'test', 'chat');
    expect(feed.rows).toHaveLength(68);
    expect(await first.checkpoint(conversations)).toBe(70);
    const positions = feed.rows.map(rowPosition);
    const unique = events.filter(firstOccurrence);
    expect(positions).toEqual(unique.map(storedPosition));
  } finally {
    await storage.close();
  }
  function firstOccurrence(row: StoredEvent) {
    return row.sequence !== 3 && row.sequence !== 68;
  }
}
function rowPosition(row: { position: number }) {
  return row.position;
}
function storedPosition(row: StoredEvent) {
  return row.sequence;
}

it('keeps original positions and ignores duplicate ids within and across racing batches',
  duplicateReplyBatches, 30_000);

function rowData(row: { data: unknown }) {
  return row.data;
}
function storedData(row: StoredEvent) {
  return row.event.data;
}

async function rejectsInvalidMiddleDelta() {
  const engine = new PGlite();
  const storage = { db: pgliteDb(engine), close: engine.close.bind(engine) };
  const events = replyEvents().slice(0, 10);
  events[4]!.event.data = { conversationId: 'chat' };
  const logger = createLogger('streaming-test', { level: 'silent' });
  const runner = new ProjectionRunner(storage.db, sourceFor(events), logger);
  try {
    await runner.initialise(conversations);
    await expect(runner.run(conversations)).rejects.toThrow('Invalid conversation event');
    expect(await runner.checkpoint(conversations)).toBe(1);
    expect((await readConversation(storage.db, 'test', 'chat')).rows).toHaveLength(1);
  } finally {
    await storage.close();
  }
}

it('validates every reply delta before saving any row in its batch',
  rejectsInvalidMiddleDelta, 30_000);
