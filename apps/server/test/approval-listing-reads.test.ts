import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import type { EventEnvelope } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { approvalCards, envelope } from '@opencrane/models';
import { fixture } from '@opencrane/models/testing';
import { approvalCardsSchema, type ApprovalCard } from '@opencrane/protocol';
import { auditTrail, conversations } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';

function identity(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject);
}

async function listingFixture() {
  const setup = await fixture();
  await setup.stopDispatch();
  await setup.runtime.stop();
  for (const projection of [conversations, auditTrail]) {
    await setup.runner.initialise(projection);
    await setup.runner.run(projection);
  }
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const chat = { silo: 'test', store: setup.nats.store, db: setup.db,
    binding: setup.binding, feed: { memberId: identity } };
  const app = buildServer(config, { chat });
  const session = { sub: 'alice', orgId: 'org-test', roles: [], authTime: 0,
    exp: Math.floor(Date.now() / 1000) + 3600 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  async function list() {
    const response = await app.inject({ url: '/api/conversations/conversation/approvals',
      headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ cards: unknown }>();
    return approvalCardsSchema.parse(body.cards);
  }
  async function close() {
    await app.close();
    await setup.close();
  }
  return { ...setup, list, close };
}

type ListingFixture = Awaited<ReturnType<typeof listingFixture>>;

async function seedUnrelated(setup: ListingFixture, count: number, prefix: string) {
  const conversationId = `noise-${prefix}`;

  const encrypted = ({ utterance: 'Unrelated reply' });
  for (let offset = 0; offset < count; offset += 100) {
    const batch: EventEnvelope[] = [];
    const end = Math.min(offset + 100, count);
    for (let index = offset; index < end; index++) {
      const data = { conversationId, turnId: 'noise-turn', messageId: `reply-${index}`,
        contentType: 'text', ...encrypted };
      const event = envelope('test', `conversation-${conversationId}`,
        'agent.message_delta', data);
      batch.push(event);
    }
    await setup.nats.seed(batch);
  }
}

async function seedApproval(setup: ListingFixture, index: number, decided = true) {
  const hexIndex = index.toString(16);
  const approvalId = hexIndex.padStart(64, '0');
  const subject = `approval-${approvalId}`;
  const review = { action: 'Read record', tool: 'read', target: 'record', data: '{}',
    destination: 'fixture', account: 'No account', consequence: 'Shows the record' };
  const text = JSON.stringify(review);
  const hash = createHash('sha256');
  hash.update(text);
  const reviewDigest = hash.digest('hex');
  const encrypted = ({ review: text });
  const digest = 'a'.repeat(64);
  const data = { approvalId, conversationId: 'conversation', turnId: 'turn',
    assistantId: 'assistant', requesterId: 'alice', tool: 'read', serverId: 'fixture',
    toolRevision: digest, schemaDigest: digest, connectionId: 'installed', profile: 'none',
    policySequence: 0, digestVersion: 'lossless-json-v1', argumentsDigest: digest,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), stepUp: false,
    ...encrypted, reviewDigest };
  const request = envelope('test', subject, 'tool.approval_requested', data);
  const decision = { approvalId, decision: 'rejected', decidedBy: 'alice' };
  const ended = envelope('test', subject, 'approval.decided', decision);
  const events = [request];
  if (decided) events.push(ended);
  await setup.nats.seed(events);
  return approvalId;
}

function countReads(store: EventStore, checkpoint: number) {
  const totals = { subscriptions: 0, subscribedEvents: 0, beforeCheckpoint: 0,
    streamRequests: 0, streamEvents: 0, unrelatedEvents: 0, eventRequests: 0,
    headRequests: 0 };
  const head = store.head.bind(store);
  const subscribe = store.subscribe.bind(store);
  const readStream = store.readStream.bind(store);
  const readEvent = store.readEvent.bind(store);
  async function* countedSubscribe(...args: Parameters<EventStore['subscribe']>) {
    totals.subscriptions++;
    for await (const row of subscribe(...args)) {
      totals.subscribedEvents++;
      if (row.sequence <= checkpoint) totals.beforeCheckpoint++;
      yield row;
    }
  }
  async function* countedStream(...args: Parameters<EventStore['readStream']>) {
    totals.streamRequests++;
    for await (const row of readStream(...args)) {
      totals.streamEvents++;
      if (row.event.subject.startsWith('conversation-noise-')) totals.unrelatedEvents++;
      yield row;
    }
  }
  async function countedHead(...args: Parameters<EventStore['head']>) {
    totals.headRequests++;
    return head(...args);
  }
  async function countedEvent(...args: Parameters<EventStore['readEvent']>) {
    totals.eventRequests++;
    return readEvent(...args);
  }
  const subscriptions = vi.spyOn(store, 'subscribe').mockImplementation(countedSubscribe);
  const streams = vi.spyOn(store, 'readStream').mockImplementation(countedStream);
  const events = vi.spyOn(store, 'readEvent').mockImplementation(countedEvent);
  const heads = vi.spyOn(store, 'head').mockImplementation(countedHead);
  function restore() {
    subscriptions.mockRestore();
    streams.mockRestore();
    events.mockRestore();
    heads.mockRestore();
  }
  return { totals, restore };
}

async function idleListingReads() {
  const setup = await listingFixture();
  try {
    await seedUnrelated(setup, 100_000, 'noise');
    await seedApproval(setup, 1);
    await setup.runner.run(auditTrail);
    const checkpoint = await setup.nats.store.head();
    const probe = countReads(setup.nats.store, checkpoint);
    try {
      for (let sample = 0; sample < 3; sample++) {
        const before = { ...probe.totals };
        const cards = await setup.list();
        expect(cards).toMatchObject([{ state: 'denied' }]);
        expect(probe.totals.beforeCheckpoint).toBe(0);
        expect(probe.totals.unrelatedEvents).toBe(0);
        expect(probe.totals.eventRequests - before.eventRequests).toBe(1);
      }
      console.log(JSON.stringify({ scenario: 'idle-100000', ...probe.totals }));
      // Missing rows must never select a second discovery path through the silo log.
      // @ts-expect-error Approval discovery rows are required even for direct callers.
      const missingRows = approvalCards(setup.nats.store, 'test', 'conversation',
        'alice');
      const result = await Promise.allSettled([missingRows]);
      expect(probe.totals.beforeCheckpoint).toBe(0);
      expect(result[0]?.status).toBe('rejected');
    } finally {
      probe.restore();
    }
  } finally {
    await setup.close();
  }
}
it('counts all discovery reads with 100,000 projected events and refuses missing rows',
  idleListingReads, 300_000);

async function stalledProjectionAndFiftyApprovals() {
  const setup = await listingFixture();
  try {
    const firstId = await seedApproval(setup, 1, false);
    await setup.runner.run(auditTrail);
    const checkpoint = await setup.nats.store.head();
    await seedUnrelated(setup, 10_000, 'noise-later');
    await seedApproval(setup, 2);
    const data = { approvalId: firstId, cancelReason: 'turn_stopped' };
    await setup.append(`approval-${firstId}`, 'approval.cancelled', data);
    const probe = countReads(setup.nats.store, checkpoint);
    let stalledCards: ApprovalCard[];
    try {
      const beganAt = performance.now();
      stalledCards = await setup.list();
      const elapsedMs = performance.now() - beganAt;
      expect(stalledCards).toMatchObject([
        { approvalId: firstId, state: 'cancelled', cancelReason: 'turn_stopped' },
        { state: 'denied' },
      ]);
      expect(probe.totals.beforeCheckpoint).toBe(0);
      expect(probe.totals.subscribedEvents).toBe(10_003);
      expect(probe.totals.eventRequests).toBe(1);
      console.log(JSON.stringify({ scenario: 'stalled-10000', elapsedMs, ...probe.totals }));
    } finally {
      probe.restore();
    }
    await setup.runner.rebuild(auditTrail);
    expect(await setup.list()).toEqual(stalledCards);
    for (let index = 3; index <= 50; index++) {
      await seedApproval(setup, index);
    }
    await setup.runner.run(auditTrail);
    const fiftyProbe = countReads(setup.nats.store, await setup.nats.store.head());
    const requests = vi.spyOn(setup.nats.connection, 'request');
    try {
      const beganAt = performance.now();
      const cards = await setup.list();
      const elapsedMs = performance.now() - beganAt;
      expect(cards).toHaveLength(50);
      expect(fiftyProbe.totals.beforeCheckpoint).toBe(0);
      expect(fiftyProbe.totals.subscribedEvents).toBe(0);
      expect(fiftyProbe.totals.eventRequests).toBe(50);
      console.log(JSON.stringify({ scenario: 'fifty-approvals', elapsedMs,
        ...fiftyProbe.totals, natsRequests: requests.mock.calls.length }));
    } finally {
      fiftyProbe.restore();
      requests.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it('lists new and cancelled approvals after a stalled projection and measures 50 cards',
  stalledProjectionAndFiftyApprovals, 120_000);
