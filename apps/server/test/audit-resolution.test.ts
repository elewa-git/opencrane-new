import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { BudgetActor, envelope, history, priceTableId, resolveEffect } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { auditDetailSchema, auditResponseSchema, type AuditRecord } from '@opencrane/protocol';
import { auditTrail, connectMemberFeed, members, pgDb, ProjectionRunner,
  rebuildAuditProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = { ...testAuthConfig(), expectedOrgId: 'org-acme' };
const canary = 'private-arguments-upstream-reply-credential-canary';
let nats: Awaited<ReturnType<typeof natsFixture>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let app: ReturnType<typeof buildServer>;
let runner: ProjectionRunner;
let logs: string;
let auth: ReturnType<typeof memberAuthorisation>;
let db: ReturnType<typeof pgDb>;

function event(type: string, subject: string, data: Record<string, unknown>) {
  const definition = getEventDefinition(type)!;
  const dataSchema = z.record(z.string(), z.unknown());
  const example = dataSchema.parse(definition.example);
  const payload = { ...example, ...data };
  return envelope('test', subject, type, payload);
}
async function append(saved: EventEnvelope) {
  const expectedSequence = await nats.store.head(saved.subject);
  const result = await nats.store.append({ event: saved, expectedSequence });
  expect(result.status).toBe('appended');
}
function headers(member = 'admin', orgId = 'org-acme') {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: member, orgId, roles: [], authTime: now, exp: now + 600 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    authorization: `Bearer ${canary}` };
}
async function setup() {
  nats = await natsFixture();
  dbs = await databases();
  fga = await openfga();
  db = pgDb(dbs.queue);
  auth = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  logs = '';
  function write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    logs += chunk.toString();
    callback();
  }
  const sink = new Writable({ write });
  const logger = createLogger('resolution-audit-test', { destination: sink, level: 'info' });
  runner = new ProjectionRunner(db, nats.store, logger);
  await runner.initialise(members);
  await runner.initialise(auditTrail);
  for (const role of ['admin', 'member'] as const) {
    const invited = event('member.invited', `member-${role}`, {
      memberId: role, role, invitationId: role,
      invitedIdentity: { issuer: config.issuerUrl, sub: role },
      expiresAt: '2030-01-01T00:00:00Z',
    });
    const joined = event('member.joined', `member-${role}`, {
      memberId: role, role, invitationId: role,
    });
    joined.principal = { kind: 'human', id: role };
    await append(invited);
    await append(joined);
    await auth.handler.handle(joined, db);
  }
  await runner.run(members);
  feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  const audit = { silo: 'test', store: nats.store, db, feed, binding: auth.binding };
  vi.stubEnv('LOG_LEVEL', 'info');
  app = buildServer(config, { audit, logDestination: sink });
  vi.unstubAllEnvs();
}
async function cleanup() {
  vi.restoreAllMocks();
  await app?.close();
  await feed?.close();
  await fga?.close();
  await dbs?.close();
  await nats?.close();
}
beforeEach(setup, 120_000);
afterEach(cleanup);

function resolution(permitId = 'permit', outcome = 'settled', settledCents = 600) {
  let evidence: Record<string, unknown>[] = [{ kind: 'provider_receipt', reference: canary,
    digest: 'a'.repeat(64), amountCents: settledCents }];
  if (outcome === 'released') {
    evidence = [{ kind: 'dispatch_record', reference: canary,
      digest: 'a'.repeat(64), notDispatched: true }];
  }
  const saved = event('effect.resolved', `effect-${permitId}`, {
    permitId, reservationId: permitId, resolvedBy: 'admin', outcome, settledCents, evidence,
  });
  saved.source = 'opencrane-server';
  saved.principal = { kind: 'human', id: 'admin' };
  saved.commandId = `${canary}-command`;
  return saved;
}
function decision(permitId = 'permit') {
  return event('decision.recorded', `decision-${permitId}`, {
    permitId, requestId: permitId, conversationId: 'protected', requesterId: 'admin',
    outcome: 'allow', reason: 'model_allowed',
  });
}
async function get(url: string) {
  const response = await app.inject({ url, headers: headers() });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(canary);
  expect(response.body).not.toContain('usage');
  expect(response.body).not.toContain('evidence');
  return response;
}
function isResolution(record: AuditRecord) {
  return record.type === 'effect.resolved';
}
async function savedRecord(anchorId: string) {
  const response = await get(`/api/org/history/${anchorId}`);
  const detail = auditDetailSchema.parse(response.json());
  const matches = detail.records.filter(isResolution);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
async function racingOperators() {
  const budget = new BudgetActor(nats.store, 'test');
  await budget.start(20000, 20000, 'group');
  const call = { model: 'gpt-6-astra', priceTableId, computerId: canary,
    assistantId: canary, requesterId: 'admin', conversationId: 'protected',
    turnId: canary, threadId: canary, payingGroupId: 'group', contextDigest: '0'.repeat(64) };
  const permitId = await budget.reserve(call, 1000);
  await budget.effect(permitId);
  const anchor = decision(permitId);
  await append(anchor);
  const joined = event('member.joined', 'member-operator', { memberId: 'operator', role: 'admin' });
  await append(joined);
  const expectedSequence = await nats.store.head(`effect-${permitId}`);
  const first = { commandId: 'first-resolution', expectedSequence, outcome: 'settled',
    settledCents: 600, evidence: [{ kind: 'provider_receipt', reference: canary,
      digest: 'a'.repeat(64), amountCents: 600 }] };
  const second = { ...first, commandId: 'second-resolution' };
  const attempts = [resolveEffect(nats.store, 'test', permitId, 'admin', first),
    resolveEffect(nats.store, 'test', permitId, 'operator', second)];
  const results = await Promise.all(attempts);
  function appended(result: typeof results[number]) {
    return result.status === 'appended';
  }
  expect(results.filter(appended)).toHaveLength(1);
  const rows = await history(nats.store, `effect-${permitId}`, 'test');
  function resolved(row: typeof rows[number]) {
    return row.event.type === 'effect.resolved';
  }
  const resolutions = rows.filter(resolved);
  expect(resolutions).toHaveLength(1);
  const saved = resolutions[0]!;
  await runner.run(auditTrail);
  const original = await savedRecord(anchor.id);
  const digest = createHash('sha256');
  digest.update(saved.event.commandId!);
  expect(original).toEqual({ eventId: saved.event.id, type: 'effect.resolved',
    position: saved.sequence, recordedAt: saved.event.time, commandRef: digest.digest('hex'),
    actor: { kind: 'person', id: saved.event.principal!.id }, source: 'authoritative',
    status: 'recorded', savedOutcome: 'settled', amountCents: 600 });
  const beforeObservation = auditResponseSchema.parse((await get(
    `/api/org/history?requestId=${permitId}`)).json());
  expect(beforeObservation.rows[0]).toMatchObject({ outcome: 'unknown', reservedCents: 1000 });
  expect(beforeObservation.rows[0]?.settledCents).toBeUndefined();
  const observation = event('effect.observed', `effect-${permitId}`, {
    permitId, outcome: 'success', costCents: 600, tool: canary, destination: canary,
  });
  await append(observation);
  await append(event('budget.ceiling_set', 'budget-test', { setBy: 'operator' }));
  await runner.run(auditTrail);
  await auditTrail.apply(db, saved.event, saved.sequence);
  expect(await savedRecord(anchor.id)).toEqual(original);
  const settlement = event('budget.settled', 'budget-test', { permitId,
    reservationId: permitId, settledCents: 600 });
  await append(settlement);
  await runner.run(auditTrail);
  expect(await savedRecord(anchor.id)).toEqual(original);
  const before = await get(`/api/org/history?requestId=${permitId}`);
  const settled = auditResponseSchema.parse(before.json());
  expect(settled.rows[0]?.settledCents).toBe(600);
  const state = structuredClone(budget.state);
  const head = await nats.store.head();
  const appends = vi.spyOn(nats.store, 'append');
  const logger = createLogger('resolution-replay', { level: 'silent' });
  await rebuildAuditProjection(db, nats.store, logger, { verify: true });
  expect(await savedRecord(anchor.id)).toEqual(original);
  expect((await get(`/api/org/history?requestId=${permitId}`)).body).toBe(before.body);
  await db.query(
    "UPDATE audit_entries SET metadata = metadata - 'savedOutcome' WHERE event_id = $1",
    [saved.event.id]);
  const rebuilt = await rebuildAuditProjection(db, nats.store, logger);
  expect(rebuilt.changed).toBe(true);
  expect(await savedRecord(anchor.id)).toEqual(original);
  expect(budget.state).toEqual(state);
  expect(appends).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(head);
  expect(logs).toContain(saved.event.id);
  expect(logs).not.toContain(canary);
}
it('retains the one racing resolver through later equal observations, edits and replay', racingOperators);

async function zeroResolution(outcome: 'settled' | 'released') {
  const anchor = decision();
  await append(anchor);
  const saved = resolution('permit', outcome, 0);
  await append(saved);
  await runner.run(auditTrail);
  expect(await savedRecord(anchor.id)).toMatchObject({ savedOutcome: outcome, amountCents: 0 });
  const list = auditResponseSchema.parse((await get('/api/org/history?requestId=permit')).json());
  expect(list.rows[0]?.outcome).toBe('unknown');
  expect(list.rows[0]?.settledCents).toBeUndefined();
}
it.each(['settled', 'released'] as const)('records %s zero without claiming budget settlement',
  zeroResolution);

const invalidCases = ['resolver', 'source', 'subject', 'permit', 'reservation', 'system',
  'agent', 'absent-principal', 'payload', 'fraction', 'negative', 'overflow', 'released-cost',
  'evidence', 'resolver-id', 'permit-id'] as const;
async function invalidResolution(invalid: typeof invalidCases[number]) {
  const saved = resolution();
  const data = z.record(z.string(), z.unknown()).parse(saved.data);
  switch (invalid) {
    case 'resolver':
      data['resolvedBy'] = 'operator';
      break;
    case 'resolver-id':
      data['resolvedBy'] = 'invalid:resolver';
      saved.principal = { kind: 'human', id: 'invalid:resolver' };
      break;
    case 'permit-id':
      data['permitId'] = 'invalid:permit';
      data['reservationId'] = 'invalid:permit';
      saved.subject = 'effect-invalid:permit';
      break;
    case 'source':
      saved.source = 'gateway';
      break;
    case 'subject':
      saved.subject = 'effect-other';
      break;
    case 'permit':
      data['permitId'] = 'other';
      break;
    case 'reservation':
      data['reservationId'] = 'other';
      break;
    case 'system':
      saved.principal = { kind: 'system', id: 'admin' };
      break;
    case 'agent':
      saved.principal = { kind: 'agent', id: 'admin' };
      break;
    case 'absent-principal':
      delete saved.principal;
      break;
    case 'payload':
      data['credential'] = canary;
      break;
    case 'fraction':
      data['settledCents'] = 0.5;
      break;
    case 'negative':
      data['settledCents'] = -1;
      break;
    case 'overflow':
      data['settledCents'] = Number.MAX_SAFE_INTEGER + 1;
      break;
    case 'released-cost':
      data['outcome'] = 'released';
      break;
    case 'evidence':
      data['evidence'] = [{ reference: canary }];
      break;
  }
  saved.data = data;
  await expect(auditTrail.apply(db, saved, 100)).rejects.toThrow('Invalid resolution audit event');
  const stored = await db.query('SELECT event_id FROM audit_entries WHERE event_id = $1', [saved.id]);
  expect(stored.rows).toEqual([]);
  expect(logs).not.toContain(canary);
}
it.each(invalidCases)('refuses untrusted resolution metadata without exposing payload: %s',
  invalidResolution);

async function conversationHistory(memberId: string) {
  const response = await app.inject({ url: '/api/conversations/protected/history',
    headers: headers(memberId) });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(canary);
  return auditResponseSchema.parse(response.json());
}
async function participantResolution(memberId: 'member' | 'admin') {
  const assistant = event('assistant.created', 'assistant-personal', {
    assistantId: 'personal', ownerId: memberId, kind: 'personal',
  });
  const conversation = event('conversation.created', 'conversation-protected', {
    conversationId: 'protected', assistantId: 'personal', createdBy: memberId,
    mode: 'agent_session',
  });
  for (const saved of [assistant, conversation]) {
    await append(saved);
    await auth.handler.handle(saved, db);
  }
  const anchor = event('decision.recorded', 'decision-permit', {
    permitId: 'permit', requestId: 'permit', conversationId: 'protected',
    requesterId: memberId, outcome: 'allow', reason: 'model_allowed',
  });
  await append(anchor);
  const reserved = event('budget.reserved', 'budget-test', {
    permitId: 'permit', reservationId: 'permit', amountCents: 1000,
  });
  await append(reserved);
  const observed = event('effect.observed', 'effect-permit', {
    permitId: 'permit', outcome: 'success', costCents: 600,
  });
  await append(observed);
  const settled = event('budget.settled', 'budget-test', {
    permitId: 'permit', reservationId: 'permit', settledCents: 600,
  });
  await append(settled);
  await runner.run(auditTrail);
  const before = await conversationHistory(memberId);
  expect(before.rows).toHaveLength(1);
  expect(before.rows[0]).toMatchObject({ decision: 'allow', outcome: 'success' });

  const saved = resolution();
  await append(saved);
  await runner.run(auditTrail);
  expect(await savedRecord(anchor.id)).toMatchObject({ savedOutcome: 'settled',
    amountCents: 600, actor: { kind: 'person', id: 'admin' } });
  const organisation = auditResponseSchema.parse((await get(
    '/api/org/history?requestId=permit')).json());
  expect(organisation.rows[0]).toMatchObject({ reservedCents: 1000, settledCents: 600 });
  expect(organisation.rows[0]?.records.find(isResolution)).toMatchObject({
    savedOutcome: 'settled', amountCents: 600, actor: { kind: 'person', id: 'admin' },
  });
  if (memberId === 'admin') {
    const demoted = event('member.role_changed', 'member-admin', {
      memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
    });
    await append(demoted);
    await auth.handler.handle(demoted, db);
    await runner.run(members);
    await runner.run(auditTrail);
  }
  const eventPosition = await nats.store.head();
  const appends = vi.spyOn(nats.store, 'append');
  for (const replay of [false, true]) {
    if (replay) {
      const logger = createLogger('participant-resolution-replay', { level: 'silent' });
      await rebuildAuditProjection(db, nats.store, logger, { verify: true });
    }
    const result = await conversationHistory(memberId);
    expect.soft(result.rows[0]?.records.filter(isResolution)).toEqual([]);
    expect.soft(result).toEqual(before);
    expect.soft(result.rows[0]?.reservedCents).toBeUndefined();
    expect.soft(result.rows[0]?.settledCents).toBeUndefined();
    for (const record of result.rows[0]!.records) {
      expect.soft(record.amountCents).toBeUndefined();
      expect.soft(record.savedOutcome).toBeUndefined();
    }
    const refused = await app.inject({ url: '/api/org/history', headers: headers(memberId) });
    expect(refused.statusCode).toBe(403);
  }
  expect(appends).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(eventPosition);
}
it.each(['member', 'admin'] as const)(
  'keeps resolution details out of the %s requester history before and after replay',
  participantResolution);

async function boundedHistory() {
  const anchor = decision();
  await append(anchor);
  await append(resolution());
  for (let index = 0; index < 52; index++) {
    await append(decision(`other-${index}`));
    await append(event('effect.observed', 'effect-permit', { permitId: 'permit',
      outcome: 'success', costCents: 600, tool: canary, destination: canary }));
  }
  await runner.run(auditTrail);
  const first = auditResponseSchema.parse((await get('/api/org/history?type=decision&limit=50')).json());
  expect(first.rows).toHaveLength(50);
  const next = auditResponseSchema.parse((await get(
    `/api/org/history?type=decision&limit=50&before=${first.nextBefore}`)).json());
  expect(next.rows).toHaveLength(3);
  const ids = new Set<string>();
  for (const row of [...first.rows, ...next.rows]) ids.add(row.id);
  expect(ids.size).toBe(53);
  const list = auditResponseSchema.parse((await get('/api/org/history?requestId=permit')).json());
  expect(list.rows[0]?.records).toHaveLength(21);
  expect(list.rows[0]?.hasMoreEvidence).toBe(true);
  const page = auditDetailSchema.parse((await get(`/api/org/history/${anchor.id}?limit=50`)).json());
  expect(page.records).toHaveLength(50);
  const older = auditDetailSchema.parse((await get(
    `/api/org/history/${anchor.id}?limit=50&before=${page.nextBefore}`)).json());
  expect(older.records).toHaveLength(4);
  const records = [...page.records, ...older.records];
  expect(records.filter(isResolution)).toHaveLength(1);
  expect(records.find(isResolution)).toMatchObject({ savedOutcome: 'settled' });
  ids.clear();
  for (const record of records) ids.add(record.eventId);
  expect(ids.size).toBe(54);
  const privateReply = await app.inject({ url: '/api/conversations/protected/history',
    headers: headers() });
  expect(privateReply.statusCode).toBe(403);
}
it('bounds list and detail above fifty records and refuses private conversation history', boundedHistory);

async function accessAfterLoading(change: 'demotion' | 'removal' | 'slow') {
  const anchor = decision();
  await append(anchor);
  await append(resolution());
  const foreign = { ...decision('foreign'), silo: 'foreign' };
  await append(foreign);
  await runner.run(auditTrail);
  const query = db.query.bind(db);
  const reads = vi.spyOn(nats.store, 'readStream');
  const heads = vi.spyOn(nats.store, 'head');
  let changed = false;
  let fail = false;
  async function load<Row extends Record<string, unknown>>(...args: Parameters<typeof db.query>) {
    if (!changed) {
      changed = true;
      if (change === 'slow') {
        const message = event('message.posted', 'conversation-unrelated', {
          conversationId: 'unrelated', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:unrelated',
        });
        await append(message);
        await delay(2100);
      } else {
        const type = change === 'demotion' ? 'member.role_changed' : 'member.removed';
        let data: Record<string, unknown> = { memberId: 'admin', previousRole: 'admin',
          newRole: 'member', changedBy: 'owner' };
        if (change === 'removal') {
          data = { memberId: 'admin', removedBy: 'owner', reason: 'access_removed' };
        }
        const saved = event(type, 'member-admin', data);
        await append(saved);
      }
      reads.mockClear();
      heads.mockClear();
    }
    if (fail) throw new Error(canary);
    return query<Row>(...args);
  }
  vi.spyOn(db, 'query').mockImplementation(load);
  const paths = ['', `/${anchor.id}`, '/missing', `/${foreign.id}`];
  for (const failed of [false, true]) {
    fail = failed;
    for (const path of paths) {
      reads.mockClear();
      const response = await app.inject({ url: `/api/org/history${path}`, headers: headers() });
      if (change !== 'slow') {
        expect(response.statusCode).toBe(403);
        expect(response.body).toBe('{"status":"refused"}');
      } else if (failed) {
        expect(response.statusCode).toBe(503);
        expect(response.body).toBe('{"status":"unavailable"}');
      } else {
        expect(response.statusCode).toBe(path === '' || path === `/${anchor.id}` ? 200 : 404);
      }
      expect(response.body).not.toContain(canary);
      function subject(call: Parameters<typeof nats.store.readStream>) {
        return call[0];
      }
      expect(reads.mock.calls.map(subject)).toEqual(['member-admin', 'ownership-test']);
      expect(heads).not.toHaveBeenCalled();
    }
  }
  if (change === 'slow') {
    expect(logs).toContain('Audit history unavailable');
    expect(logs).toContain('Audit detail unavailable');
  }
  expect(logs).not.toContain(canary);
}
it.each(['demotion', 'removal', 'slow'] as const)(
  'checks access once after successful or failed history loads: %s', accessAfterLoading);
