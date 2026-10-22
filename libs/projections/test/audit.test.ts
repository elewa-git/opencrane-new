import { z } from 'zod';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { eventRegistry, getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { AuditFilter, AuditRow } from '@opencrane/protocol';
import type { Query } from '../src/db.ts';
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
    const dispatchEvidence = ['tool.dispatch_started', 'tool.dispatch_recorded'].includes(event.type);
    const expected = previouslyAllowed || ownershipEvidence || invitationEvidence || dispatchEvidence;
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
      { ...fixture('member.invited', 'invited', {
        invitedBy: 'alice', email: `private-email-${canary}@example.test`,
      }, false), principal: { kind: 'human' as const, id: 'alice' } },
      { ...fixture('team.created', 'team-canary', {
        createdBy: 'alice', name: `private-name-${canary}`,
      }, false), principal: { kind: 'human' as const, id: 'alice' } },
    ];
    for (let index = 0; index < events.length; index++) {
      const event = { ...events[index]!, commandId: `private-command-${canary}-${index}` };
      expect((await nats.store.append({ event, expectedSequence: 0 })).status).toBe('appended');
    }
    await runner.run(auditTrail);
    const before = await readAudit(db.db, 'test', { limit: 50 });
    const byId = new Map(before.rows.map(row => [row.id, row.records[0]]));
    expect(byId.get('verified')).toMatchObject({ actor: { kind: 'person', id: 'alice' } });
    expect(byId.get('spoofed')?.actor?.kind).not.toBe('person');
    expect(byId.get('system')?.actor?.kind).toBe('system');
    expect(byId.get('requested')?.actor?.kind).not.toBe('person');
    expect(byId.get('invited')?.actor).toEqual({ kind: 'person', id: 'alice' });
    expect(byId.get('team-canary')?.actor).toEqual({ kind: 'person', id: 'alice' });
    expect(byId.get('verified')?.recordedAt).toBe('2026-10-03T00:00:00Z');
    expect(byId.get('verified')?.commandRef).toMatch(/^[a-f0-9]{64}$/u);
    expect((await readAudit(db.db, 'test', { actorId: 'alice' })).rows.map(row => row.id))
      .toEqual(['team-canary', 'invited', 'verified']);
    expect(JSON.stringify(before)).not.toContain(canary);
    expect((await rebuildAuditProjection(db.db, nats.store, logger, { verify: true })).changed)
      .toBe(false);
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
        { requestId: `request-${position}`, permitId: `permit-${position}`, outcome }, false);
      await auditTrail.apply(db.db, event, position);
    }
    const first = await readAudit(db.db, 'test', { limit: 50 });
    await auditTrail.apply(db.db, fixture('decision.recorded', 'later',
      { requestId: 'request-later', outcome: 'allow' }, false), 121);
    const second = await readAudit(db.db, 'test', { before: first.nextBefore, limit: 50 });
    const third = await readAudit(db.db, 'test', { before: second.nextBefore, limit: 50 });
    expect([...first.rows, ...second.rows, ...third.rows].map(row => row.id))
      .toEqual(Array.from({ length: 120 }, (_, index) => `anchor-${120 - index}`));
    expect((await readAudit(db.db, 'test', { actorId: 'missing' })).rows).toEqual([]);
    expect((await readAudit(db.db, 'test', { from: '2026-10-04T00:00:00Z' })).rows)
      .toEqual([]);
    expect((await readAudit(db.db, 'test', { to: '2026-10-02T23:59:59Z' })).rows)
      .toEqual([]);
    expect((await readAudit(db.db, 'test', { reference: 'anchor-120' })).rows)
      .toHaveLength(1);
    expect((await readAudit(db.db, 'test', { reference: 'request-120' })).rows)
      .toHaveLength(1);
    expect((await readAudit(db.db, 'test', { reference: 'permit-120' })).rows)
      .toHaveLength(1);
    // Check startup replaces an earlier index and remains safe to repeat.
    await db.db.query(`CREATE INDEX audit_event_type
      ON audit_entries (silo, event_type, position DESC)`);
    await auditTrail.create(db.db);
    await auditTrail.create(db.db);
    const indexes = (await db.db.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'audit_entries'", [])).rows;
    for (const column of ['recorded_at', 'actor_id', 'outcome']) {
      const index = indexes.find(candidate => candidate.indexname === `audit_${column}`);
      expect(index?.indexdef).toContain(`(silo, ${column}, "position" DESC)`);
    }
    function isTypeIndex(index: { indexname: string }): boolean {
      return index.indexname === 'audit_event_type_bytewise';
    }
    function isEarlierTypeIndex(index: { indexname: string }): boolean {
      return index.indexname === 'audit_event_type';
    }
    expect(indexes.find(isEarlierTypeIndex)).toBeUndefined();
    const typeIndex = indexes.find(isTypeIndex);
    expect(typeIndex?.indexdef).toContain('(silo, event_type COLLATE "C", "position" DESC)');
    for (let position = 122; position < 622; position++) {
      const event = fixture('effect.uncertain', `related-${position}`,
        { permitId: 'permit-120' }, false);
      await auditTrail.apply(db.db, event, position);
    }
    const summary = await readAudit(db.db, 'test', { requestId: 'request-120' });
    expect(summary.rows[0]?.records).toHaveLength(21);
    expect(summary.rows[0]?.hasMoreEvidence).toBe(true);
    const seen: string[] = [];
    let before: number | undefined;
    do {
      const detail = await readAuditDetail(db.db, 'test', 'anchor-120', { before, limit: 50 });
      expect(detail).toBeDefined();
      seen.push(...detail!.records.map(record => record.eventId));
      before = detail!.nextBefore;
    } while (before);
    const expected = Array.from({ length: 500 }, (_, index) => `related-${621 - index}`);
    expected.push('anchor-120');
    expect(seen).toEqual(expected);
  } finally { await db.close(); }
}, 90_000);

async function agentMatchingCommandField(): Promise<void> {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    const base = fixture('budget.ceiling_set', 'agent-command', { setBy: 'worker' }, false);
    const event: EventEnvelope = {
      ...base,
      principal: { kind: 'agent', id: 'worker' },
    };
    await auditTrail.apply(db.db, event, 1);
    const result = await readAudit(db.db, 'test');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.records[0]?.actor).toEqual({ kind: 'agent', id: 'worker' });
  } finally {
    await db.close();
  }
}
it('keeps an agent matching the command actor field separate from a person',
  agentMatchingCommandField);

async function ignoresActorData(): Promise<void> {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    const base = fixture('budget.ceiling_set', 'actor-data', { setBy: 'alice' }, false);
    const data = z.record(z.string(), z.unknown()).parse(base.data);
    // Exercise the projection directly: typed events reject this extra field.
    // Keep these rows in their own database so replay tests see only saved events.
    const event: EventEnvelope = {
      ...base,
      data: { ...data, actor: 'mallory' },
      principal: { kind: 'human', id: 'mallory' },
    };
    await auditTrail.apply(db.db, event, 1);
    const result = await readAudit(db.db, 'test');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.records[0]?.actor).toEqual({ kind: 'unverified' });
  } finally {
    await db.close();
  }
}
it('ignores data.actor even when it matches the human principal', ignoresActorData);

async function seedMixedAnchors(db: Query): Promise<void> {
  let position = 0;
  for (let index = 1; index <= 30; index++) {
    const events = [
      fixture('decision.recorded', `allowed-${index}`, {
        requestId: `allowed-request-${index}`, permitId: `allowed-permit-${index}`,
        outcome: 'allow', reason: 'model_allowed',
      }, false),
      fixture('decision.recorded', `denied-${index}`, {
        requestId: `denied-request-${index}`, permitId: `denied-permit-${index}`,
        outcome: 'deny', reason: 'policy_block',
      }, false),
      fixture('gateway.observation_recorded', `gateway-error-${index}`, {
        requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        outcome: 'error', reason: 'jwt_failed',
      }, false),
      fixture('gateway.observation_recorded', `gateway-unknown-${index}`, {
        requestId: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
        outcome: 'unknown', reason: 'observation_missing',
      }, false),
    ];
    for (const event of events) {
      position++;
      await auditTrail.apply(db, event, position);
    }
  }
}

function rowId(row: AuditRow): string {
  return row.id;
}

async function readAllFilteredIds(db: Query, filter: AuditFilter): Promise<string[]> {
  const ids: string[] = [];
  let before: number | undefined;
  do {
    const page = await readAudit(db, 'test', { ...filter, before, limit: 7 });
    const pageIds = page.rows.map(rowId);
    ids.push(...pageIds);
    if (page.nextBefore !== undefined) {
      expect(page.nextBefore).toBeLessThan(before ?? Infinity);
    }
    before = page.nextBefore;
  } while (before !== undefined);
  return ids;
}

interface FilterCase {
  name: string;
  filter: AuditFilter;
  prefixes: string[];
}
const filterCases: FilterCase[] = [
  { name: 'decision type', filter: { type: 'decision' }, prefixes: ['allowed', 'denied'] },
  { name: 'gateway type', filter: { type: 'gateway' },
    prefixes: ['gateway-error', 'gateway-unknown'] },
  { name: 'not_dispatched outcome', filter: { outcome: 'not_dispatched' },
    prefixes: ['denied'] },
  { name: 'error outcome', filter: { outcome: 'error' }, prefixes: ['gateway-error'] },
  { name: 'unknown outcome', filter: { outcome: 'unknown' },
    prefixes: ['allowed', 'gateway-unknown'] },
];

async function filtersEveryPage(testCase: FilterCase): Promise<void> {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    // Reproduce language sorting that ignores punctuation, as some hosts do by default.
    await db.db.query(`CREATE COLLATION audit_test_language
      (provider = icu, locale = 'en-US-u-ka-shifted')`);
    await db.db.query(`ALTER TABLE audit_entries
      ALTER COLUMN event_type TYPE TEXT COLLATE audit_test_language`);
    await seedMixedAnchors(db.db);
    const expectedIds: string[] = [];
    for (const prefix of testCase.prefixes) {
      for (let index = 1; index <= 30; index++) {
        expectedIds.push(`${prefix}-${index}`);
      }
    }
    const actualIds = await readAllFilteredIds(db.db, testCase.filter);
    actualIds.sort();
    expectedIds.sort();
    expect(actualIds).toEqual(expectedIds);
  } finally {
    await db.close();
  }
}
it.each(filterCases)('returns exactly the $name matches across every page', filtersEveryPage);

async function rejectsUnsafeDispatchData(): Promise<void> {
  const db = await database('pg');
  try {
    await auditTrail.create(db.db);
    for (const type of ['tool.dispatch_started', 'tool.dispatch_recorded']) {
      const saved = fixture(type, type);
      const data = z.record(z.string(), z.unknown()).parse(saved.data);
      for (const field of ['arguments', 'reply', 'credential']) {
        const invalid = { ...saved, data: { ...data, [field]: canary } };
        const applying = auditTrail.apply(db.db, invalid, 1);
        await expect(applying).rejects.toThrow('Invalid dispatch audit event');
      }
    }
    const rows = await db.db.query('SELECT * FROM audit_entries');
    expect(rows.rows).toEqual([]);
  } finally {
    await db.close();
  }
}
it('strictly validates dispatch data without storing arguments, replies or credentials',
  rejectsUnsafeDispatchData);
