import { z } from 'zod';
import type { EventEnvelope } from '@opencrane/events';
import { auditReasons, auditResponseSchema, type AuditRow, type AuditRecord, type AuditFilter } from '@opencrane/protocol';
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
  'credential.released',
  'security.alert_raised',
  'gateway.observation_recorded',
  // These exact types are the safe computer and membership summaries.
  'agent.command_ran',
  'agent.file_changed',
  'member.joined',
  'member.role_changed',
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
const identifier = z.string().regex(/^[\w:.-]{1,300}$/u);
const safeId = (value: unknown) => identifier.safeParse(value).data;
const amount = (value: unknown) => z.number().int().nonnegative().safe().safeParse(value).data;
const firstId = (...values: unknown[]) => safeId(values.find(value => value !== undefined));
interface Entry extends Record<string, unknown> {
  event_id: string; position: string | number; request_id: string | null; permit_id: string | null; approval_id: string | null;
  conversation_id: string | null; turn_id: string | null; requester_id: string | null; metadata: unknown;
}
function metadata(event: EventEnvelope, d: Record<string, unknown>, position: number): AuditRecord {
  const status = z.enum(['allow', 'ask', 'deny', 'success', 'error', 'unknown', 'not_dispatched']).safeParse(d['outcome']).data;
  const reason = typeof d['reason'] === 'string' ? Object.entries(auditReasons).find(([code]) => code === d['reason'])?.[1] ?? 'Recorded reason withheld' : undefined;
  const cents = amount(d['amountCents'] ?? d['settledCents']);
  return { eventId: event.id, type: event.type, position,
    source: event.type === 'decision.recorded' ? 'decision' : /^(effect|gateway|egress)\./u.test(event.type) ? 'gateway'
      : event.type.startsWith('agent.') ? 'computer' : 'authoritative',
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
    for (const key of ['request_id', 'permit_id', 'approval_id', 'conversation_id', 'requester_id', 'turn_id', 'decision']) {
      await db.query(`CREATE INDEX IF NOT EXISTS audit_${key} ON audit_entries (silo, ${key}, position DESC)`);
    }
    await db.query('CREATE INDEX IF NOT EXISTS audit_turn_evidence ON audit_entries (silo, conversation_id, turn_id, position)');
    await db.query('CREATE INDEX IF NOT EXISTS audit_anchors ON audit_entries (silo, anchor, position DESC)');
  },
  async drop(db) { await db.query('DROP TABLE IF EXISTS audit_entries'); },
  async apply(db, event, position) {
    if (!isAuditEventType(event.type)) return;
    const d = z.record(z.string(), z.unknown()).parse(event.data);
    const call = z.record(z.string(), z.unknown()).safeParse(d['modelCall']).data ?? {};
    const request = firstId(d['requestId'], call['requestId'], event.correlation.request);
    const permit = firstId(d['permitId'], event.correlation.permit);
    const approval = firstId(d['approvalId'], event.correlation.approval);
    const anchor = isAnchor(event, request, permit, approval);
    const digest = z.string().regex(/^[a-f0-9]{64}$/u).safeParse(d['contextDigest']).data;
    await db.query(`INSERT INTO audit_entries VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (silo, event_id) DO NOTHING`, [event.silo, event.id, position, anchor, request, permit, approval,
      firstId(d['conversationId'], call['conversationId'], event.correlation.conversation),
      firstId(d['turnId'], call['turnId'], event.correlation.turn),
      firstId(d['requesterId'], call['requesterId'], d['requestedBy']),
      event.type === 'decision.recorded' ? d['outcome'] : null, digest, JSON.stringify(metadata(event, d, position))].map(value => value ?? null));
  },
};

function isAnchor(event: EventEnvelope, request: string | undefined, permit: string | undefined,
  approval: string | undefined): boolean {
  // Decisions and alerts always start rows; correlated records attach to their action.
  // Uncorrelated effects stay evidence, while a gateway observation without a permit needs a row.
  if (event.type === 'security.alert_raised') {
    return true;
  }
  if (event.type === 'decision.recorded') {
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

/** Indexed anchors plus their relevant evidence. Positions order events; gateway time is never read. */
export async function readAudit(db: Query, silo: string, filter: AuditFilter & { conversationId?: string; requesterId?: string } = {}) {
  const where = ['silo = $1', 'anchor = TRUE']; const parameters: unknown[] = [silo];
  for (const [key, value] of Object.entries({ conversation_id: filter.conversationId, requester_id: filter.requesterId,
    request_id: filter.requestId, turn_id: filter.turnId, decision: filter.decision })) {
    if (value !== undefined) { parameters.push(value); where.push(`${key} = $${parameters.length}`); }
  }
  if (filter.before !== undefined) { parameters.push(filter.before); where.push(`position < $${parameters.length}`); }
  const anchors = (await db.query<Entry>(`SELECT * FROM audit_entries WHERE ${where.join(' AND ')} ORDER BY position DESC LIMIT 51`, parameters)).rows;
  const page = anchors.slice(0, 50);
  const requests = page.flatMap(e => e.request_id ? [e.request_id] : []), permits = page.flatMap(e => e.permit_id ? [e.permit_id] : []);
  const turns = [...new Map(page.filter(e => e.conversation_id && e.turn_id)
    .map(e => [JSON.stringify([e.conversation_id, e.turn_id]), e])).values()];
  const related = (await db.query<Entry>(`SELECT * FROM audit_entries WHERE silo = $1 AND
    (request_id = ANY($2::text[]) OR permit_id = ANY($3::text[])) ORDER BY position`, [silo, requests, permits])).rows;
  // Match each conversation and turn together, so unrelated events cannot add rows to the audit view.
  const context = await Promise.all(turns.map(turn => db.query<Entry>(`SELECT * FROM audit_entries
    WHERE silo = $1 AND conversation_id = $2 AND turn_id = $3 AND request_id IS NULL AND permit_id IS NULL ORDER BY position`,
    [silo, turn.conversation_id, turn.turn_id])));
  related.push(...context.flatMap(result => result.rows));
  const approvals = related.flatMap(e => e.approval_id ? [e.approval_id] : []);
  const lifecycle = approvals.length ? (await db.query<Entry>('SELECT * FROM audit_entries WHERE silo = $1 AND approval_id = ANY($2::text[]) ORDER BY position', [silo, approvals])).rows : [];
  const rows = page.map(anchor => explain(anchor, [...related, ...lifecycle]));
  return auditResponseSchema.parse({ rows, ...(anchors.length > 50 ? { nextBefore: Number(page.at(-1)!.position) } : {}) });
}
function explain(anchor: Entry, entries: Entry[]): AuditRow {
  const selected = entries.filter(e => (anchor.request_id && e.request_id === anchor.request_id) || (anchor.permit_id && e.permit_id === anchor.permit_id) || contextEvidence(anchor, e));
  const approvalIds = selected.flatMap(e => e.approval_id ? [e.approval_id] : []);
  const all = [...selected, ...entries.filter(e => e.approval_id && approvalIds.includes(e.approval_id)), anchor];
  const records = [...new Map(all.map(e => [e.event_id, auditResponseSchema.shape.rows.element.shape.records.element.parse(e.metadata)])).values()]
    .sort((a, b) => a.position - b.position);
  const decision = z.enum(['allow', 'ask', 'deny']).safeParse(anchor['decision']).data ?? 'not_recorded';
  const effect = records.findLast(r => r.type === 'effect.observed' || r.type === 'egress.observed');
  const settlement = records.findLast(r => r.type === 'budget.settled');
  const reservation = records.find(r => r.type === 'budget.reserved');
  const outcome = observedOutcome(decision, records, effect, settlement);
  return auditResponseSchema.shape.rows.element.parse({ id: anchor.event_id, decision, outcome, records,
    requestId: anchor.request_id ?? undefined, permitId: anchor.permit_id ?? undefined,
    conversationId: anchor.conversation_id ?? undefined, turnId: anchor.turn_id ?? undefined,
    requesterId: anchor.requester_id ?? undefined, contextDigest: anchor['context_digest'] ?? undefined,
    reservedCents: reservation?.amountCents, settledCents: settlement?.amountCents });
}

function observedOutcome(decision: AuditRow['decision'], records: AuditRecord[], effect?: AuditRecord, settlement?: AuditRecord) {
  if (records.some(r => r.type === 'security.alert_raised')) return 'unknown';
  if (effect && decision === 'allow') return effect.status;
  if (settlement?.status === 'not_dispatched' || ['ask', 'deny'].includes(decision)) return 'not_dispatched';
  if (decision === 'allow') return 'unknown';
  const gateway = records.findLast(r => r.type === 'gateway.observation_recorded');
  return gateway ? gateway.status === 'unknown' ? 'unknown' : 'error' : 'recorded';
}

function contextEvidence(anchor: Entry, entry: Entry) {
  return Boolean(anchor.conversation_id && anchor.turn_id && !entry.request_id && !entry.permit_id &&
    anchor.conversation_id === entry.conversation_id && anchor.turn_id === entry.turn_id &&
    (!entry.requester_id || anchor.requester_id === entry.requester_id));
}
