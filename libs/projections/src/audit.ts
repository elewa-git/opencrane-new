import { z } from 'zod';
import { createHash } from 'node:crypto';
import { effectResolvedDataSchema, getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { auditReasons, auditResponseSchema, auditDetailSchema, type AuditRow,
  type AuditRecord, type AuditFilter, type AuditDetailFilter } from '@opencrane/protocol';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

// Free text never enters this projection, including approval reasons and tool arguments.
const auditPrefixes = [
  // Record decisions and effects with fields chosen for the audit view.
  'decision.',
  'effect.',
  // Record approval and connection changes without private review text.
  'approval.',
  'mcp.',
  'connection.',
  'egress.',
  'takeover.',
  // These event families expose safe lifecycle summaries.
  'team.',
  'ownership.',
  'assistant.',
  'grant.',
];
const auditTypes = new Set([
  // Budget records expose amounts and outcomes without request content.
  'budget.reserved',
  'budget.settled',
  'budget.ceiling_set',
  'budget.exhausted',
  // Security and gateway records explain refused or observed work.
  'tool.approval_requested',
  'tool.dispatch_started',
  'tool.dispatch_recorded',
  'credential.released',
  'security.alert_raised',
  'gateway.observation_recorded',
  // These exact types are the safe computer and membership summaries.
  'agent.command_ran',
  'agent.file_changed',
  'member.invited',
  'member.command_refused',
  'member.joined',
  'member.role_changed',
  'member.ownership_confirmed',
  'member.removed',
  'computer.claimed',
  'silo.owner_bootstrapped',
  'computer.ready',
  'computer.suspended',
  'computer.resumed',
  'computer.lost',
  'computer.retired',
]);
export function isAuditEventType(type: string): boolean {
  if (auditTypes.has(type)) {
    return true;
  }
  for (const prefix of auditPrefixes) {
    if (type.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
function isDispatchEvent(type: string): boolean {
  return type === 'tool.dispatch_started' || type === 'tool.dispatch_recorded';
}
function auditData(event: EventEnvelope): Record<string, unknown> {
  const dataSchema = z.record(z.string(), z.unknown());
  if (event.type === 'effect.resolved') {
    return resolutionData(event);
  }
  if (isDispatchEvent(event.type)) {
    const definition = getEventDefinition(event.type)!;
    const dispatchSchema = definition.dataSchema;
    const parseResult = dispatchSchema.safeParse(event.data);
    if (!parseResult.success) {
      // Keep rejected arguments, replies and credentials out of projection errors.
      throw new Error('Invalid dispatch audit event');
    }
    return dataSchema.parse(parseResult.data);
  }
  return dataSchema.parse(event.data);
}
function resolutionData(event: EventEnvelope): Record<string, unknown> {
  const parsed = effectResolvedDataSchema.safeParse(event.data);
  if (!parsed.success) {
    // Keep private evidence and rejected fields out of projection errors.
    throw new Error('Invalid resolution audit event');
  }
  const data = parsed.data;
  const receiptId = z.string().regex(/^[\w-]{1,200}$/u);
  if (event.source !== 'opencrane-server' || event.subject !== `effect-${data.permitId}` ||
      data.reservationId !== data.permitId || event.principal?.kind !== 'human' ||
      event.principal.id !== data.resolvedBy || !receiptId.safeParse(data.resolvedBy).success ||
      !receiptId.safeParse(data.permitId).success) {
    throw new Error('Invalid resolution audit event');
  }
  return data;
}
function dispatchStatus(outcome: unknown): AuditRecord['status'] {
  if (outcome === 'outcome_unknown') {
    return 'unknown';
  }
  if (outcome === 'not_dispatched') {
    return 'not_dispatched';
  }
  return 'recorded';
}
const identifier = z.string().regex(/^[\w:.-]{1,300}$/u);
const safeId = (value: unknown) => identifier.safeParse(value).data;
const amount = (value: unknown) => z.number().int().nonnegative().safe().safeParse(value).data;
const firstId = (...values: unknown[]) => safeId(values.find(value => value !== undefined));
interface Entry extends Record<string, unknown> {
  event_id: string; position: string | number; request_id: string | null; permit_id: string | null; approval_id: string | null;
  conversation_id: string | null; turn_id: string | null; requester_id: string | null; metadata: unknown;
}
const verifiedActorFields: Record<string, string> = {
  'effect.resolved': 'resolvedBy',
  'budget.ceiling_set': 'setBy',
  'mcp.tool_mode_set': 'setBy',
  'member.invited': 'invitedBy',
  'member.role_changed': 'changedBy',
  'member.removed': 'removedBy',
  'team.created': 'createdBy',
  'ownership.transferred': 'transferredBy',
  'ownership.stepped_down': 'memberId',
  'takeover.requested': 'requestedBy',
  'takeover.refused': 'actorId',
};
function actor(event: EventEnvelope, data: Record<string, unknown>): AuditRecord['actor'] {
  const principal = event.principal;
  if (!principal) return { kind: 'unverified' };
  const principalId = safeId(principal.id);
  if (principal.kind === 'system') return { kind: 'system', ...(principalId ? { id: principalId } : {}) };
  if (principal.kind === 'agent') return { kind: 'agent', ...(principalId ? { id: principalId } : {}) };
  const fieldName = verifiedActorFields[event.type];
  const verifiedField = fieldName ? data[fieldName] : undefined;
  if (principalId && verifiedField === principalId) return { kind: 'person', id: principalId };
  return { kind: 'unverified' };
}
function commandRef(event: EventEnvelope): string | undefined {
  if (!event.commandId) return undefined;
  return createHash('sha256').update(event.commandId).digest('hex');
}
function invitationMetadata(event: EventEnvelope, data: Record<string, unknown>) {
  if (!['member.invited', 'member.command_refused'].includes(event.type)) {
    return {};
  }
  const operation = z.enum(['invite', 'join']).safeParse(data['operation']).data;
  const role = z.enum(['owner', 'admin', 'member']).safeParse(data['role']).data;
  return {
    memberId: safeId(data['memberId']), invitationId: safeId(data['invitationId']),
    operation, role,
  };
}
function membershipMetadata(event: EventEnvelope, data: Record<string, unknown>): Partial<AuditRecord> {
  const memberId = safeId(data['memberId']);
  const role = z.enum(['owner', 'admin', 'member']);
  switch (event.type) {
    case 'member.joined':
      return { operation: 'join', memberId, role: role.safeParse(data['role']).data,
        invitationId: safeId(data['invitationId']) };
    case 'member.removed':
      return { operation: 'remove', memberId };
    case 'member.role_changed':
      return { operation: 'role_change', memberId,
        previousRole: role.safeParse(data['previousRole']).data,
        newRole: role.safeParse(data['newRole']).data };
    case 'ownership.transferred': {
      if (data['awaitingConfirmation'] === true) {
        return { operation: 'transfer_intent', memberId };
      }
      return { operation: 'appointment', memberId, newRole: 'owner' };
    }
    case 'member.ownership_confirmed':
      return { operation: 'ownership_confirmation', memberId, newRole: 'owner',
        appointmentId: safeId(data['appointmentId']) };
    case 'ownership.stepped_down':
      return { operation: 'step_down', memberId, previousRole: 'owner', newRole: 'admin' };
    default:
      return {};
  }
}
function isDestinationRule(event: EventEnvelope) {
  return ['egress.destination_allowed', 'egress.destination_revoked'].includes(event.type);
}
function auditSource(event: EventEnvelope): AuditRecord['source'] {
  if (event.type === 'decision.recorded') return 'decision';
  if (event.type === 'effect.resolved') {
    return 'authoritative';
  }
  if (event.type === 'tool.dispatch_recorded') {
    return 'gateway';
  }
  if (isDestinationRule(event)) return 'authoritative';
  if (/^(effect|gateway|egress)\./u.test(event.type)) return 'gateway';
  if (event.type.startsWith('agent.')) return 'computer';
  return 'authoritative';
}
function takeoverMetadata(event: EventEnvelope, data: Record<string, unknown>) {
  if (!event.type.startsWith('takeover.')) return {};
  const turns = z.array(identifier).safeParse(data['affectedTurnIds']).data;
  const generation = z.int().positive().safeParse(data['generation']).data;
  return { computerId: safeId(data['computerId']), generation,
    takeoverId: safeId(data['takeoverId']), leaseId: safeId(data['leaseId']),
    requesterEventId: safeId(data['requesterEventId']), affectedTurnCount: turns?.length };
}
function metadata(event: EventEnvelope, d: Record<string, unknown>, position: number): AuditRecord {
  let status: AuditRecord['status'] | undefined = z.enum([
    'allow', 'ask', 'deny', 'success', 'error', 'unknown', 'not_dispatched',
  ]).safeParse(d['outcome']).data;
  if (isDispatchEvent(event.type)) {
    status = dispatchStatus(d['outcome']);
  }
  const reason = typeof d['reason'] === 'string' ? Object.entries(auditReasons).find(([code]) => code === d['reason'])?.[1] ?? 'Recorded reason withheld' : undefined;
  const cents = amount(d['amountCents'] ?? d['settledCents']);
  const digest = commandRef(event);
  let savedOutcome: AuditRecord['savedOutcome'];
  if (event.type === 'effect.resolved') {
    savedOutcome = z.enum(['settled', 'released']).parse(d['outcome']);
  }
  return { ...invitationMetadata(event, d), ...takeoverMetadata(event, d),
    ...membershipMetadata(event, d),
    // Keep a saved money choice separate from observations and budget settlement.
    savedOutcome,
    eventId: event.id, type: event.type, position, recordedAt: event.time,
    actor: actor(event, d), ...(digest ? { commandRef: digest } : {}),
    source: auditSource(event),
    status: event.type === 'effect.uncertain' ? 'unknown' : status ?? 'recorded',
    ...(reason ? { reason } : {}), ...(cents !== undefined ? { amountCents: cents } : {}) };
}
export const auditTrail: Projection = {
  name: 'audit',
  async create(db) {
    await db.query(`CREATE TABLE IF NOT EXISTS audit_entries (
      silo TEXT NOT NULL, event_id TEXT NOT NULL, position BIGINT NOT NULL, anchor BOOLEAN NOT NULL,
      request_id TEXT, permit_id TEXT, approval_id TEXT, conversation_id TEXT, turn_id TEXT, requester_id TEXT,
      decision TEXT, context_digest TEXT, metadata JSONB NOT NULL, PRIMARY KEY (silo, event_id))`);
    for (const column of ['recorded_at TIMESTAMPTZ', 'event_type TEXT',
      'actor_id TEXT', 'outcome TEXT']) {
      await db.query(`ALTER TABLE audit_entries ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const column of ['recorded_at', 'actor_id', 'outcome']) {
      await db.query(`CREATE INDEX IF NOT EXISTS audit_${column}
        ON audit_entries (silo, ${column}, position DESC)`);
    }
    // Keep the index and prefix comparisons in the same bytewise order on every host.
    await db.query(`CREATE INDEX IF NOT EXISTS audit_event_type_bytewise
      ON audit_entries (silo, event_type COLLATE "C", position DESC)`);
    await db.query('DROP INDEX IF EXISTS audit_event_type');
    await db.query(`CREATE INDEX IF NOT EXISTS audit_ownership_confirmation
      ON audit_entries (silo, (metadata->>'appointmentId'), (metadata->>'memberId'), position)
      WHERE event_type = 'member.ownership_confirmed'`);
    for (const key of ['request_id', 'permit_id', 'approval_id', 'conversation_id', 'requester_id', 'turn_id', 'decision']) {
      await db.query(`CREATE INDEX IF NOT EXISTS audit_${key} ON audit_entries (silo, ${key}, position DESC)`);
    }
    await db.query('CREATE INDEX IF NOT EXISTS audit_turn_evidence ON audit_entries (silo, conversation_id, turn_id, position)');
    await db.query('CREATE INDEX IF NOT EXISTS audit_anchors ON audit_entries (silo, anchor, position DESC)');
  },
  async drop(db) { await db.query('DROP TABLE IF EXISTS audit_entries'); },
  async apply(db, event, position) {
    if (!isAuditEventType(event.type)) return;
    const d = auditData(event);
    const call = z.record(z.string(), z.unknown()).safeParse(d['modelCall']).data ?? {};
    const request = firstId(d['requestId'], call['requestId'], event.correlation.request);
    // Bind dispatch evidence to its saved request, never another attempt's correlation.
    const permit = isDispatchEvent(event.type) ? undefined :
      firstId(d['permitId'], event.correlation.permit);
    const approval = firstId(d['approvalId'], event.correlation.approval);
    const anchor = isAnchor(event, request, permit, approval);
    const digest = z.string().regex(/^[a-f0-9]{64}$/u).safeParse(d['contextDigest']).data;
    const record = metadata(event, d, position);
    let requesterId = firstId(d['requesterId'], call['requesterId'], d['requestedBy']);
    if (event.type === 'takeover.refused' && record.actor?.kind === 'person') {
      requesterId = record.actor.id;
    }
    await db.query(`INSERT INTO audit_entries (silo,event_id,position,anchor,request_id,permit_id,
      approval_id,conversation_id,turn_id,requester_id,decision,context_digest,metadata,
      recorded_at,event_type,actor_id,outcome)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (silo, event_id) DO NOTHING`, [event.silo, event.id, position, anchor, request, permit, approval,
      firstId(d['conversationId'], call['conversationId'], event.correlation.conversation),
      firstId(d['turnId'], call['turnId'], event.correlation.turn),
      requesterId,
      event.type === 'decision.recorded' ? d['outcome'] : null, digest, JSON.stringify(record),
      event.time, event.type, record.actor?.kind === 'unverified' ? null : record.actor?.id,
      record.status].map(value => value ?? null));
    if (anchor || ['effect.observed', 'egress.observed', 'budget.settled',
      'security.alert_raised', 'gateway.observation_recorded',
      'tool.dispatch_started', 'tool.dispatch_recorded'].includes(event.type)) {
      await refreshOutcomes(db, event.silo, request, permit, event.id);
    }
  },
};

async function refreshOutcomes(db: Query, silo: string, request: string | undefined,
  permit: string | undefined, eventId: string): Promise<void> {
  const anchors = (await db.query<Entry>(`SELECT * FROM audit_entries WHERE silo = $1
    AND anchor = TRUE AND (event_id = $2 OR request_id = $3 OR permit_id = $4)`,
  [silo, eventId, request ?? null, permit ?? null])).rows;
  for (const anchor of anchors) {
    const signals = await readSignals(db, silo, anchor);
    const summary = explain(anchor, [], signals, false);
    await db.query('UPDATE audit_entries SET outcome = $3 WHERE silo = $1 AND event_id = $2',
      [silo, anchor.event_id, summary.outcome]);
  }
}

function isAnchor(event: EventEnvelope, request: string | undefined, permit: string | undefined,
  approval: string | undefined): boolean {
  // Decisions and alerts always start rows; correlated records attach to their action.
  // Uncorrelated effects stay evidence, while a gateway observation without a permit needs a row.
  if (event.type.startsWith('takeover.')) return true;
  if (event.type === 'security.alert_raised') {
    return true;
  }
  if (event.type === 'decision.recorded' || isDestinationRule(event)) {
    return true;
  }
  if (event.type === 'gateway.observation_recorded' && !permit) {
    return true;
  }
  if (request || permit || approval) {
    return false;
  }
  return !event.type.startsWith('effect.');
}

/** Read indexed anchors, then a fixed number of related records for each row. */
function checkedAuditLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid audit limit');
  return limit;
}

export async function readAudit(db: Query, silo: string,
  filter: AuditFilter & { conversationId?: string; requesterId?: string } = {}) {
  const where = ['silo = $1', 'anchor = TRUE'];
  const parameters: unknown[] = [silo];
  const equality = {
    conversation_id: filter.conversationId, requester_id: filter.requesterId,
    request_id: filter.requestId, turn_id: filter.turnId, decision: filter.decision,
    actor_id: filter.actorId, outcome: filter.outcome,
  };
  for (const [column, value] of Object.entries(equality)) {
    if (value === undefined) continue;
    parameters.push(value);
    where.push(`${column} = $${parameters.length}`);
  }
  if (filter.type) {
    parameters.push(`${filter.type}.`);
    const start = parameters.length;
    parameters.push(`${filter.type}/`);
    where.push(`event_type COLLATE "C" >= $${start}
      AND event_type COLLATE "C" < $${parameters.length}`);
  }
  if (filter.from) {
    parameters.push(filter.from);
    where.push(`recorded_at >= $${parameters.length}`);
  }
  if (filter.to) {
    parameters.push(filter.to);
    where.push(`recorded_at <= $${parameters.length}`);
  }
  if (filter.reference) {
    parameters.push(filter.reference);
    const index = parameters.length;
    where.push(`(event_id = $${index} OR request_id = $${index} OR permit_id = $${index})`);
  }
  if (filter.before !== undefined) {
    parameters.push(filter.before);
    where.push(`position < $${parameters.length}`);
  }
  const limit = checkedAuditLimit(filter.limit);
  parameters.push(limit + 1);
  const sql = `SELECT * FROM audit_entries WHERE ${where.join(' AND ')}
    ORDER BY position DESC LIMIT $${parameters.length}`;
  const anchors = (await db.query<Entry>(sql, parameters)).rows;
  const page = anchors.slice(0, limit);
  const rows: AuditRow[] = [];
  for (const anchor of page) {
    const related = await readEvidence(db, silo, anchor, undefined, 21, false);
    const signals = await readSignals(db, silo, anchor);
    const row = explain(anchor, related.slice(0, 20), signals, related.length > 20);
    rows.push(row);
  }
  const nextBefore = anchors.length > limit ? Number(page.at(-1)!.position) : undefined;
  return auditResponseSchema.parse({ rows, ...(nextBefore ? { nextBefore } : {}) });
}

function evidenceCondition(alias: string): string {
  return `(${alias}.request_id = $3 OR ${alias}.permit_id = $4 OR
    (${alias}.conversation_id = $5 AND ${alias}.turn_id = $6 AND
      ${alias}.request_id IS NULL AND ${alias}.permit_id IS NULL AND
      (${alias}.requester_id IS NULL OR ${alias}.requester_id = $7)))`;
}

async function readEvidence(db: Query, silo: string, anchor: Entry,
  before: number | undefined, limit: number, includeAnchor: boolean): Promise<Entry[]> {
  const direct = evidenceCondition('e');
  const matching = evidenceCondition('linked');
  const parameters: unknown[] = [silo, anchor.event_id, anchor.request_id,
    anchor.permit_id, anchor.conversation_id, anchor.turn_id, anchor.requester_id];
  const anchorCondition = includeAnchor ? 'e.event_id = $2 OR ' : '';
  const excludeAnchor = includeAnchor ? '' : 'AND e.event_id <> $2';
  const beforeCondition = before === undefined ? '' : 'AND e.position < $8';
  if (before !== undefined) parameters.push(before);
  parameters.push(limit);
  const sql = `SELECT e.* FROM audit_entries e WHERE e.silo = $1 ${excludeAnchor}
    ${beforeCondition} AND (${anchorCondition}${direct} OR
      (e.event_type NOT IN ('tool.dispatch_started', 'tool.dispatch_recorded')
        AND e.approval_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM audit_entries linked WHERE linked.silo = $1
          AND linked.approval_id = e.approval_id AND ${matching})))
    ORDER BY e.position DESC LIMIT $${parameters.length}`;
  return (await db.query<Entry>(sql, parameters)).rows;
}

async function readSignals(db: Query, silo: string, anchor: Entry): Promise<Entry[]> {
  const types = ['effect.observed', 'egress.observed', 'security.alert_raised',
    'budget.settled', 'budget.reserved', 'gateway.observation_recorded',
    'tool.dispatch_started', 'tool.dispatch_recorded'];
  const parameters = [silo, anchor.event_id, anchor.request_id, anchor.permit_id,
    anchor.conversation_id, anchor.turn_id, anchor.requester_id, types];
  const direct = evidenceCondition('e');
  const sql = `SELECT DISTINCT ON (e.event_type) e.* FROM audit_entries e
    WHERE e.silo = $1 AND e.event_type = ANY($8::text[])
      AND (e.event_id = $2 OR ${direct})
    ORDER BY e.event_type, e.position DESC`;
  return (await db.query<Entry>(sql, parameters)).rows;
}

export async function readAuditDetail(db: Query, silo: string, auditId: string,
  filter: AuditDetailFilter = { limit: 20 }) {
  const anchor = (await db.query<Entry>(
    'SELECT * FROM audit_entries WHERE silo = $1 AND event_id = $2 AND anchor = TRUE',
    [silo, auditId])).rows[0];
  if (!anchor) return undefined;
  const page = await readEvidence(db, silo, anchor, filter.before, filter.limit + 1, true);
  const records = page.slice(0, filter.limit).map(entry => auditResponseSchema.shape.rows.element
    .shape.records.element.parse(entry.metadata));
  const nextBefore = page.length > filter.limit ? Number(page[filter.limit - 1]!.position) : undefined;
  return auditDetailSchema.parse({ id: anchor.event_id, records,
    ...(nextBefore ? { nextBefore } : {}) });
}

function explain(anchor: Entry, entries: Entry[], signals: Entry[],
  hasMoreEvidence: boolean): AuditRow {
  const records = [anchor, ...entries].map(entry => auditResponseSchema.shape.rows.element
    .shape.records.element.parse(entry.metadata)).sort((left, right) => left.position - right.position);
  const summaryEntries = new Map<string, Entry>();
  for (const entry of [anchor, ...signals]) summaryEntries.set(entry.event_id, entry);
  const summaryRecords = [...summaryEntries.values()].map(entry => auditResponseSchema.shape.rows
    .element.shape.records.element.parse(entry.metadata))
    .sort((left, right) => left.position - right.position);
  const decision = z.enum(['allow', 'ask', 'deny']).safeParse(anchor['decision']).data ?? 'not_recorded';
  const effect = summaryRecords.findLast(r => r.type === 'effect.observed' || r.type === 'egress.observed');
  const settlement = summaryRecords.findLast(r => r.type === 'budget.settled');
  const reservation = summaryRecords.find(r => r.type === 'budget.reserved');
  const outcome = observedOutcome(decision, summaryRecords, effect, settlement);
  return auditResponseSchema.shape.rows.element.parse({ id: anchor.event_id, decision, outcome, records,
    ...(hasMoreEvidence ? { hasMoreEvidence } : {}),
    requestId: anchor.request_id ?? undefined, permitId: anchor.permit_id ?? undefined,
    conversationId: anchor.conversation_id ?? undefined, turnId: anchor.turn_id ?? undefined,
    requesterId: anchor.requester_id ?? undefined, contextDigest: anchor['context_digest'] ?? undefined,
    reservedCents: reservation?.amountCents, settledCents: settlement?.amountCents });
}

function observedOutcome(decision: AuditRow['decision'], records: AuditRecord[], effect?: AuditRecord, settlement?: AuditRecord) {
  if (records.some(r => r.type === 'security.alert_raised')) return 'unknown';
  const dispatch = records.findLast(isRecordedDispatch);
  // Keep transport evidence separate from business success and generic gateway observations.
  if (dispatch && decision === 'allow') {
    return dispatch.status;
  }
  // Keep a saved start without its outcome unknown, even after generic success.
  if (decision === 'allow' && records.some(isDispatchStart)) {
    return 'unknown';
  }
  if (effect && decision === 'allow') return effect.status;
  if (settlement?.status === 'not_dispatched' || ['ask', 'deny'].includes(decision)) return 'not_dispatched';
  if (decision === 'allow') return 'unknown';
  const gateway = records.findLast(r => r.type === 'gateway.observation_recorded');
  return gateway ? gateway.status === 'unknown' ? 'unknown' : 'error' : 'recorded';
}

function isRecordedDispatch(record: AuditRecord): boolean {
  return record.type === 'tool.dispatch_recorded';
}

function isDispatchStart(record: AuditRecord): boolean {
  return record.type === 'tool.dispatch_started';
}

/** Find only the confirmation of this appointment, without reading member history. */
export async function readAuditOwnershipConfirmation(db: Query, silo: string,
  intent: AuditRecord): Promise<AuditRecord | undefined> {
  const result = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM audit_entries WHERE silo = $1
      AND event_type = 'member.ownership_confirmed' AND metadata->>'appointmentId' = $2
      AND metadata->>'memberId' = $3 AND position > $4 ORDER BY position LIMIT 2`,
    [silo, intent.eventId, intent.memberId, intent.position]);
  // Refuse to choose between conflicting confirmations.
  if (result.rows.length !== 1) {
    return undefined;
  }
  return auditResponseSchema.shape.rows.element.shape.records.element.parse(result.rows[0]!.metadata);
}
