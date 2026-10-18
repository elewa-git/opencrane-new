import { z } from 'zod';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { eventRegistry, getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { auditTrail, readAudit, readAuditDetail, rebuildAuditProjection, ProjectionRunner } from '../src/index.ts';
import { isAuditEventType } from '../src/audit.ts';
import { database } from './database.ts';

const canary = 'private-approval-bearer-arguments-canary';
function auditAllowListIncludesOwnership(): void {
  const previousPattern = [
    '^(silo\\.owner_bootstrapped|decision\\.|budget\\.(reserved|settled|ceiling_set|exhausted)|',
    'effect\\.|approval\\.|tool\\.approval_requested|credential\\.released|mcp\\.|connection\\.|',
    'egress\\.|takeover\\.|security\\.alert_raised|gateway\\.observation_recorded|',
    'agent\\.(command_ran|file_changed)|',
    'member\\.(joined|role_changed|removed)|team\\.|assistant\\.|grant\\.|',
    'computer\\.(claimed|ready|suspended|resumed|lost|retired))',
  ].join('');
  const previousAllowList = new RegExp(previousPattern, 'u');

  const ownershipTypes = [
    'ownership.seeded',
    'ownership.transferred',
    'ownership.stepped_down',
  ];
  for (const event of eventRegistry) {
    const previouslyAllowed = previousAllowList.test(event.type);
    const ownershipEvidence = ownershipTypes.includes(event.type);
    const invitationEvidence = ['member.invited', 'member.command_refused'].includes(event.type);
    const expected = previouslyAllowed || ownershipEvidence || invitationEvidence;
    expect(isAuditEventType(event.type), event.type).toBe(expected);
  }
}
it('preserves the existing audit allow-list and includes ownership evidence',
  auditAllowListIncludesOwnership);

function fixture(type: string, id: string, data: Record<string, unknown> = {}, correlated = true): EventEnvelope {
  const definition = getEventDefinition(type);
  expect(definition, `typed ${type} contract`).toBeDefined();
  const eventData = { ...z.record(z.string(), z.unknown()).parse(definition!.example), ...data };
  let subject = `${definition!.stream}-${id.replaceAll('.', '-')}`;
  if (definition!.stream === 'mcp') {
    subject = `mcp-${String(eventData['serverId'])}`;
  }
  const parsed = parseEventByType({ id, commandId: id, principal: { id: 'fixture', kind: 'system' }, type, source: 'fixture', silo: 'test', subject,
    time: '2026-10-03T00:00:00Z', correlation: correlated ? { request: 'request', permit: 'permit', conversation: 'conversation', turn: 'turn' } : {},
    data: eventData });
  if (!parsed.success) throw new Error(`Invalid fixture ${type}: ${parsed.reason}`);
  return parsed.event;
}
it('joins forthcoming typed families, withholds private details and keeps absent outcomes unknown through replay', async () => {
  const db = await database('pg'), nats = await natsFixture();
  const runner = new ProjectionRunner(db.db, nats.store, createLogger('audit-test', { level: 'silent' }));
  try {
    await runner.initialise(auditTrail);
    const append = async (event: EventEnvelope) => {
      const expectedSequence = await nats.store.head(event.subject);
      expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
    };
    // Deliberately before the decision: joins use ids, never equal/ambiguous gateway times.
    for (const [type, payload] of [
      ['tool.approval_requested', { approvalId: 'approval' }],
      ['approval.decided', { approvalId: 'approval', reason: canary }],
      ['approval.used', { approvalId: 'approval', permitId: 'permit' }],
      ['approval.expired', { approvalId: 'approval' }],
      ['credential.released', { requestId: 'request', permitId: 'permit' }],
      ['mcp.tools_changed', {}], ['mcp.server_published', {}], ['egress.observed', { outcome: 'unknown' }],
      ['takeover.started', { requestedBy: 'alice' }], ['takeover.ended', {}],
    ] as const) {
      const record = fixture(type, type, payload);
      await append(type.startsWith('approval.') ? { ...record, correlation: {} } : type.startsWith('takeover.') ? { ...record, correlation: { conversation: 'conversation', turn: 'turn' } } : record);
    }
    await append(fixture('decision.recorded', 'decision', { requestId: 'request', permitId: 'permit', conversationId: 'conversation', turnId: 'turn',
      requesterId: 'alice', outcome: 'allow', reason: 'model_allowed' }));
    // Unrelated conversation and silo must never join even when ids collide across silos.
    await append({ ...fixture('approval.decided', 'foreign', { reason: canary }), silo: 'other' });
    await append(fixture('decision.recorded', 'foreign-conversation', { requestId: 'other', conversationId: 'other', requesterId: 'bob' }, false));
    await append({ ...fixture('takeover.started', 'foreign-turn', { requestedBy: 'alice' }, false), correlation: { conversation: 'other', turn: 'turn' } });
    await append({ ...fixture('takeover.started', 'foreign-requester', { requestedBy: 'bob' }, false), correlation: { conversation: 'conversation', turn: 'turn' } });
    const privateMessageData = {
      conversationId: 'conversation',
      ciphertext: Buffer.from(canary).toString('base64'),
    };
    const privateMessage = fixture('message.posted', 'private-message', privateMessageData);
    const privateConversationMessage = { ...privateMessage, subject: 'conversation-conversation' };
    await append(privateConversationMessage);
    await runner.run(auditTrail);
    const before = await readAudit(db.db, 'test', { conversationId: 'conversation', requesterId: 'alice' });
    expect(before.rows.filter(row => row.requestId === 'request')).toHaveLength(1);
    expect(before.rows[0]?.outcome).toBe('unknown');
    await rebuildAuditProjection(db.db, nats.store, createLogger('audit-test', { level: 'silent' }), { verify: true });
    const request = before.rows.find(row => row.requestId === 'request');
    expect(request?.records).toHaveLength(11);
    expect(request?.records.map(record => record.type)).toContain('takeover.started');
    expect(request?.records.map(record => record.eventId)).not.toContain('foreign-turn');
    expect(request?.records.map(record => record.eventId)).not.toContain('foreign-requester');
    expect(JSON.stringify(before)).not.toContain(canary);
    expect(JSON.stringify(before)).not.toContain(Buffer.from(canary).toString('base64'));
    await db.reopen();
    await new ProjectionRunner(db.db, nats.store, createLogger('audit-test', { level: 'silent' })).rebuild(auditTrail);
    expect(await readAudit(db.db, 'test', { conversationId: 'conversation', requesterId: 'alice' })).toEqual(before);
    expect((await readAudit(db.db, 'test', { requestId: 'request' })).rows).toHaveLength(1);
    expect((await readAudit(db.db, 'test', { conversationId: 'conversation', requesterId: 'bob', requestId: 'request' })).rows).toEqual([]);
  } finally { await nats.close(); await db.close(); }
}, 30_000);

it('pages indexed requests without truncating evidence and preserves an unverified unknown observation', async () => {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    for (let i = 1; i <= 52; i++) {
      const event = fixture('decision.recorded', `decision-${i}`, { requestId: `request-${i}`, conversationId: 'conversation', requesterId: 'alice',
        outcome: 'allow', reason: 'model_allowed' }, false);
      await auditTrail.apply(db.db, event, i);
      await auditTrail.apply(db.db, event, i); // At-least-once projection delivery.
    }
    const unknown = fixture('gateway.observation_recorded', 'gateway-unknown', { requestId: '00000000-0000-4000-8000-000000000001', outcome: 'unknown', reason: 'observation_missing' }, false);
    await auditTrail.apply(db.db, unknown, 53);
    const first = await readAudit(db.db, 'test', { limit: 50 });
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]).toMatchObject({ decision: 'not_recorded', outcome: 'unknown' });
    expect(first.rows[0]?.requesterId).toBeUndefined();
    const second = await readAudit(db.db, 'test', { before: first.nextBefore! });
    expect(second.rows).toHaveLength(3);
    expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(53);
    expect((await readAudit(db.db, 'test', { requestId: 'request-1' })).rows[0]?.requestId).toBe('request-1');
    expect((await readAudit(db.db, 'test', { decision: 'deny' })).rows).toEqual([]);
  } finally { await db.close(); }
}, 30_000);

it('summarises confirmed egress success and error while keeping missing observations uncertain through replay', async () => {
  const db = await database('pg'), nats = await natsFixture();
  const runner = new ProjectionRunner(db.db, nats.store, createLogger('audit-test', { level: 'silent' }));
  try {
    await runner.initialise(auditTrail);
    for (const outcome of ['success', 'error', 'unknown', 'missing'] as const) {
      const requestId = `egress-${outcome}`, permitId = `permit-${outcome}`;
      const events = [fixture('decision.recorded', `decision-${outcome}`, { requestId, permitId, route: 'egress',
        conversationId: 'conversation', requesterId: 'alice', outcome: 'allow', reason: 'policy_allow' }, false)];
      if (outcome !== 'missing') events.unshift(fixture('egress.observed', `observation-${outcome}`, {
        requestId, permitId, channel: outcome === 'error' ? 'desktop' : 'command', outcome }, false));
      for (const event of events) expect((await nats.store.append({ event, expectedSequence: 0 })).status).toBe('appended');
    }
    await runner.run(auditTrail);
    const before = await readAudit(db.db, 'test', { conversationId: 'conversation', requesterId: 'alice' });
    expect(before.rows).toHaveLength(4);
    for (const [requestId, outcome] of [['egress-success', 'success'], ['egress-error', 'error'],
      ['egress-unknown', 'unknown'], ['egress-missing', 'unknown']]) {
      expect(before.rows.find(row => row.requestId === requestId)).toMatchObject({ decision: 'allow', outcome });
    }
    await runner.rebuild(auditTrail);
    expect(await readAudit(db.db, 'test', { conversationId: 'conversation', requesterId: 'alice' })).toEqual(before);
  } finally { await nats.close(); await db.close(); }
}, 30_000);

it('records only verified actors and digests, with no private text after replay', async () => {
  const db = await database('pg');
  const nats = await natsFixture();
  const logger = createLogger('audit-fields', { level: 'silent' });
  const runner = new ProjectionRunner(db.db, nats.store, logger);
  try {
    await runner.initialise(auditTrail);
    const events = [
      { ...fixture('budget.ceiling_set', 'verified', { setBy: 'alice' }, false),
        principal: { kind: 'human' as const, id: 'alice' } },
      { ...fixture('budget.ceiling_set', 'spoofed', { setBy: 'alice' }, false),
        principal: { kind: 'human' as const, id: 'mallory' } },
      { ...fixture('budget.ceiling_set', 'system', { setBy: 'alice' }, false),
        principal: { kind: 'system' as const, id: 'worker' } },
      { ...fixture('takeover.started', 'requested', { requestedBy: 'alice' }, false),
        principal: { kind: 'human' as const, id: 'mallory' } },
    ];
    for (let index = 0; index < events.length; index++) {
      const event = { ...events[index]!, commandId: `private-command-${canary}-${index}` };
      expect((await nats.store.append({ event, expectedSequence: 0 })).status).toBe('appended');
    }
    await runner.run(auditTrail);
    const before = await readAudit(db.db, 'test', { limit: 50 });
    const byId = new Map(before.rows.map(row => [row.id, row.records[0]]));
    expect(byId.get('verified')).toMatchObject({ actor: { kind: 'person', id: 'alice' } });
    expect(byId.get('spoofed')?.actor.kind).not.toBe('person');
    expect(byId.get('system')?.actor.kind).toBe('system');
    expect(byId.get('requested')?.actor.kind).not.toBe('person');
    expect(byId.get('verified')?.recordedAt).toBe('2026-10-03T00:00:00Z');
    expect(byId.get('verified')?.commandRef).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(before)).not.toContain(canary);
    expect((await rebuildAuditProjection(db.db, nats.store, logger, { verify: true })).changed)
      .toBe(false);
    expect(await readAudit(db.db, 'test', { limit: 50 })).toEqual(before);
  } finally { await nats.close(); await db.close(); }
}, 30_000);

it('filters indexed anchors and pages evidence without repeating records', async () => {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    for (let position = 1; position <= 120; position++) {
      const outcome = position % 2 ? 'allow' : 'deny';
      const event = fixture('decision.recorded', `anchor-${position}`,
        { requestId: `request-${position}`, outcome }, false);
      await auditTrail.apply(db.db, event, position);
    }
    const first = await readAudit(db.db, 'test', { limit: 50 });
    await auditTrail.apply(db.db, fixture('decision.recorded', 'later',
      { requestId: 'request-later', outcome: 'allow' }, false), 121);
    const second = await readAudit(db.db, 'test', { before: first.nextBefore, limit: 50 });
    const third = await readAudit(db.db, 'test', { before: second.nextBefore, limit: 50 });
    expect([...first.rows, ...second.rows, ...third.rows].map(row => row.id))
      .toEqual(Array.from({ length: 120 }, (_, index) => `anchor-${120 - index}`));
    expect((await readAudit(db.db, 'test', { outcome: 'deny', limit: 50 })).rows)
      .toHaveLength(50);
    expect((await readAudit(db.db, 'test', { type: 'decision', limit: 50 })).rows)
      .toHaveLength(50);
    expect((await readAudit(db.db, 'test', { actorId: 'missing' })).rows).toEqual([]);
    expect((await readAudit(db.db, 'test', { from: '2026-10-04T00:00:00Z' })).rows)
      .toEqual([]);
    for (let position = 122; position < 622; position++) {
      const event = fixture('effect.uncertain', `related-${position}`,
        { requestId: 'request-120' }, false);
      await auditTrail.apply(db.db, event, position);
    }
    const summary = await readAudit(db.db, 'test', { requestId: 'request-120' });
    expect(summary.rows[0]?.records).toHaveLength(20);
    expect(summary.rows[0]?.hasMoreEvidence).toBe(true);
    const seen: string[] = [];
    let before: number | undefined;
    do {
      const detail = await readAuditDetail(db.db, 'test', 'anchor-120', { before, limit: 50 });
      expect(detail).toBeDefined();
      seen.push(...detail!.records.map(record => record.eventId));
      before = detail!.nextBefore;
    } while (before);
    expect(seen).toHaveLength(501);
    expect(new Set(seen).size).toBe(501);
  } finally { await db.close(); }
}, 90_000);
