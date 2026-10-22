import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { envelope } from '@opencrane/models';
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

function event(type: string, subject: string, data: Record<string, unknown>) {
  const example = z.record(z.string(), z.unknown()).parse(getEventDefinition(type)!.example);
  return envelope('test', subject, type, { ...example, ...data });
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
  const db = pgDb(dbs.queue);
  const auth = memberAuthorisation(await createStore(fga.apiUrl, 'test'));
  logs = '';
  function write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    logs += chunk.toString();
    callback();
  }
  const sink = new Writable({ write });
  const logger = createLogger('dispatch-audit-test', { destination: sink });
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
  app = buildServer(config, { audit, logDestination: sink });
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

type Outcome = 'responded' | 'outcome_unknown' | 'not_dispatched';
function dispatchEvents(outcome?: Outcome) {
  const requestId = randomUUID();
  const subject = `decision-${requestId}`;
  const approvalId = randomUUID();
  const decision = event('decision.recorded', subject, {
    requestId, permitId: requestId, route: 'mcp', outcome: 'allow', reason: 'policy_allow',
    requesterId: 'admin', conversationId: 'conversation', turnId: 'turn',
    serverId: 'server', toolName: 'write', callId: 'call', logicalRequestId: 'a'.repeat(64),
  });
  decision.correlation = { approval: approvalId };
  const binding = { connectionId: 'installed', generation: 1,
    recordDigest: 'b'.repeat(64), reviewRevision: 1 };
  const start = event('tool.dispatch_started', subject, {
    requestId, serverId: 'server', ...binding,
    ...(outcome === 'not_dispatched' ? {} : { adapter: 'remote_https' }),
  });
  start.id = `${requestId}:tool-dispatch-started`;
  let evidence = 'adapter_transport_uncertain';
  if (outcome === 'responded') {
    evidence = 'adapter_response_received';
  }
  if (outcome === 'not_dispatched') {
    evidence = 'dispatch_refused';
  }
  const adapter = { ...binding, decisionId: decision.id, startId: start.id };
  const observation = event('tool.dispatch_recorded', subject, {
    requestId, approvalId, conversationId: 'conversation', turnId: 'turn',
    serverId: 'server', toolName: canary, callId: canary, logicalRequestId: 'a'.repeat(64),
    startedAt: start.time, durationMs: 10, outcome: outcome ?? 'outcome_unknown', evidence,
    ...(outcome === 'not_dispatched' ? {} : { adapter }),
  });
  observation.id = `${requestId}:tool-dispatch`;
  return { requestId, decision, start, observation, approvalId };
}
function recordId(record: AuditRecord) {
  return record.eventId;
}
async function list(requestId: string, outcome?: string) {
  let url = `/api/org/history?requestId=${requestId}`;
  if (outcome !== undefined) {
    url += `&outcome=${outcome}`;
  }
  const reply = await app.inject({ url, headers: headers() });
  expect(reply.statusCode).toBe(200);
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.body).not.toContain(canary);
  return auditResponseSchema.parse(reply.json());
}
async function detail(id: string, before?: number) {
  let url = `/api/org/history/${id}?limit=7`;
  if (before !== undefined) {
    url += `&before=${before}`;
  }
  const reply = await app.inject({ url, headers: headers() });
  expect(reply.statusCode).toBe(200);
  expect(reply.body).not.toContain(canary);
  return auditDetailSchema.parse(reply.json());
}
async function savedOutcome(outcome: Outcome) {
  const saved = dispatchEvents(outcome);
  await append(saved.decision);
  await append(saved.start);
  await append(saved.observation);
  await runner.run(auditTrail);
  const statuses = { responded: 'recorded', outcome_unknown: 'unknown',
    not_dispatched: 'not_dispatched' };
  const expectedStatus = statuses[outcome];
  const before = await list(saved.requestId);
  expect(before.rows).toHaveLength(1);
  const row = before.rows[0]!;
  expect(row.records.map(recordId)).toEqual([
    saved.decision.id, saved.start.id, saved.observation.id,
  ]);
  expect(row.records[1]).toMatchObject({ type: 'tool.dispatch_started', status: 'recorded' });
  expect(row.records[2]).toMatchObject({ type: 'tool.dispatch_recorded', status: expectedStatus });
  expect(row.outcome).toBe(expectedStatus);
  expect(await list(saved.requestId, expectedStatus)).toEqual(before);
  expect(row.reservedCents).toBeUndefined();
  expect(row.settledCents).toBeUndefined();
  const firstDetail = await detail(saved.decision.id);
  expect(firstDetail.records.map(recordId)).toEqual([
    saved.observation.id, saved.start.id, saved.decision.id,
  ]);
  // Deliver the saved observation again, then rebuild all rows from the real event store.
  const position = firstDetail.records[0]!.position;
  await auditTrail.apply(pgDb(dbs.queue), saved.observation, position);
  const head = await nats.store.head();
  const appends = vi.spyOn(nats.store, 'append');
  const logger = createLogger('audit-replay', { level: 'silent' });
  await rebuildAuditProjection(pgDb(dbs.queue), nats.store, logger, { verify: true });
  expect(await list(saved.requestId)).toEqual(before);
  expect(await detail(saved.decision.id)).toEqual(firstDetail);
  await dbs.queue.query("DELETE FROM audit_entries WHERE event_type LIKE 'tool.dispatch_%'");
  const rebuilt = await rebuildAuditProjection(pgDb(dbs.queue), nats.store, logger);
  expect(rebuilt.changed).toBe(true);
  expect(await list(saved.requestId)).toEqual(before);
  expect(appends).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(head);
  const rows = await dbs.queue.query('SELECT * FROM audit_entries');
  expect(JSON.stringify(rows.rows)).not.toContain(canary);
  expect(logs).not.toContain(canary);
  expect(await nats.store.head('budget-test')).toBe(0);
}
it.each(['responded', 'outcome_unknown', 'not_dispatched'] as const)(
  'reads saved %s dispatch evidence through authorised list and detail, including replay',
  savedOutcome);

async function boundedUnknown() {
  const saved = dispatchEvents('outcome_unknown');
  await append(saved.decision);
  await runner.run(auditTrail);
  expect((await list(saved.requestId)).rows[0]?.outcome).toBe('unknown');
  await append(saved.start);
  await runner.run(auditTrail);
  expect((await list(saved.requestId)).rows[0]?.outcome).toBe('unknown');
  await append(saved.observation);
  const expected = [saved.decision.id, saved.start.id, saved.observation.id];
  for (let index = 0; index < 25; index++) {
    const generic = event('gateway.observation_recorded', `gateway-${index}`, {
      requestId: saved.requestId, outcome: 'error', reason: 'observation_missing',
    });
    generic.correlation = { permit: saved.requestId };
    await append(generic);
    expected.push(generic.id);
  }
  const genericEffect = event('effect.observed', 'effect-later', {
    permitId: saved.requestId, outcome: 'success', costCents: 0,
    tool: canary, destination: canary,
  });
  await append(genericEffect);
  expected.push(genericEffect.id);
  await runner.run(auditTrail);
  const page = await list(saved.requestId);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]?.outcome).toBe('unknown');
  expect(page.rows[0]?.hasMoreEvidence).toBe(true);
  expect(page.rows[0]?.records).toHaveLength(21);
  const seen: string[] = [];
  let before: number | undefined;
  do {
    const page = await detail(saved.decision.id, before);
    seen.push(...page.records.map(recordId));
    before = page.nextBefore;
  } while (before !== undefined);
  expected.reverse();
  expect(seen).toEqual(expected);
  await runner.rebuild(auditTrail);
  expect(await list(saved.requestId)).toEqual(page);
}
it('keeps missing and adapter-unknown dispatch uncertain with bounded, ordered evidence',
  boundedUnknown);

async function isolatesAttempts() {
  const saved = dispatchEvents('responded');
  const other = dispatchEvents('outcome_unknown');
  await append(saved.decision);
  await append(saved.start);
  await append(saved.observation);
  // Reuse an approval but keep the second attempt's own request authoritative.
  const otherData = z.record(z.string(), z.unknown()).parse(other.observation.data);
  other.observation.data = { ...otherData, approvalId: saved.approvalId };
  other.observation.correlation = { request: saved.requestId, permit: saved.requestId };
  await append(other.observation);
  const approval = event('approval.decided', `approval-${saved.approvalId}`, {
    approvalId: saved.approvalId, reason: canary,
  });
  await append(approval);
  const foreign = { ...saved.observation, id: randomUUID(), silo: 'other' };
  await append(foreign);
  await runner.run(auditTrail);
  const records = (await detail(saved.decision.id)).records;
  expect(records.map(recordId)).toEqual([
    approval.id, saved.observation.id, saved.start.id, saved.decision.id,
  ]);
  expect((await list(saved.requestId)).rows).toHaveLength(1);
  for (const path of ['', `/${saved.decision.id}`]) {
    const foreignReply = await app.inject({ url: `/api/org/history${path}`,
      headers: headers('admin', 'other-org') });
    expect(foreignReply.statusCode).toBe(403);
    expect(foreignReply.body).not.toContain(saved.decision.id);
  }
  for (const member of ['member', 'admin']) {
    if (member === 'admin') {
      await append(event('member.role_changed', 'member-admin', {
        memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
      }));
    }
    for (const path of ['', `/${saved.decision.id}`]) {
      const reply = await app.inject({ url: `/api/org/history${path}`, headers: headers(member) });
      expect(reply.statusCode).toBe(403);
      expect(reply.body).not.toContain(saved.decision.id);
    }
  }
  await append(event('member.removed', 'member-admin', { memberId: 'admin' }));
  for (const path of ['', `/${saved.decision.id}`]) {
    const reply = await app.inject({ url: `/api/org/history${path}`, headers: headers() });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).not.toContain(saved.decision.id);
  }
}
it('isolates dispatch attempts and silos and refuses ordinary, demoted and removed readers',
  isolatesAttempts);
