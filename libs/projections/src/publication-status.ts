import { z } from 'zod';
import { gatewayConfigurationSchema, gatewayObservationSchema, getEventDefinition,
  type EventEnvelope } from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';
import type { Query } from './db.ts';
import { isToolPolicyAvailable, isToolReviewCurrent } from './tool-policy.ts';

const types = new Set(['gateway.configuration_requested', 'gateway.configuration_observed',
  'mcp.server_published', 'mcp.server_unpublished', 'mcp.server_registered']);
const identifier = z.string().regex(/^[\w-]{1,200}$/u);
const unknown = { status: 'unknown', stage: 'read', reason: 'unavailable' };
type Configuration = z.infer<typeof gatewayConfigurationSchema>;
type Observation = z.infer<typeof gatewayObservationSchema>;
type Member = Configuration['members'][number];
type Row = { type: string; data: unknown; time: string; position: string };

export async function createPublicationRecords(db: Query, table: string) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    silo TEXT NOT NULL, subject TEXT NOT NULL, type TEXT NOT NULL, command_id TEXT,
    position BIGINT NOT NULL, time TEXT NOT NULL, data JSONB NOT NULL,
    PRIMARY KEY (silo, position))`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_subject
    ON ${table} (silo, subject, type, position DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_command ON ${table} (silo, command_id)`);
}

export async function applyPublicationRecord(db: Query, table: string,
  event: EventEnvelope, position: number) {
  if (!types.has(event.type)) return;
  let data = getEventDefinition(event.type)!.dataSchema.parse(event.data);
  if (event.type === 'mcp.server_registered') {
    // Keep the original command's type without copying its address or image locator.
    const fields = z.object({ serverId: z.string(), kind: z.string() });
    const registration = fields.parse(data);
    data = registration;
  }
  const values = [event.silo, event.subject, event.type, event.commandId,
    position, event.time, JSON.stringify(data)];
  await db.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING`, values);
}

async function boundedRead<Result>(work: () => Promise<Result>): Promise<Result> {
  function expired(_resolve: (value: never) => void, reject: (reason: Error) => void) {
    function timeout() {
      reject(new Error('Publication read unavailable'));
    }
    timer = setTimeout(timeout, 10_000);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>(expired);
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readPublication(db: Query, silo: string, serverId: string,
  now = new Date()) {
  identifier.parse(serverId);
  async function read() {
    // Read all parts in one database snapshot so a receipt cannot cross a newer intent.
    const result = await db.query<Row>(`SELECT 'policy' AS type, policy AS data,
      changed_at AS time, position::text FROM mcp_catalogue WHERE silo = $1 AND server_id = $2
      UNION ALL
      (SELECT DISTINCT ON (type) type, data, time, position::text
        FROM mcp_publication_records records WHERE silo = $1 AND subject IN ($3, $4)
        ORDER BY type, records.position DESC)`, [silo, serverId, `mcp-${serverId}`, `gateway-config-${silo}`]);
    return publicationStatus(result.rows, serverId, now);
  }
  try {
    return await boundedRead(read);
  } catch {
    return unknown;
  }
}

export async function publicationChange(db: Query, silo: string, commandId: string,
  now = new Date()) {
  identifier.parse(commandId);
  async function read() {
    const result = await db.query<Row>(`SELECT type, data, time, position::text
      FROM mcp_publication_records records WHERE silo = $1 AND command_id = $2
      ORDER BY records.position`,
    [silo, commandId]);
    // Leave hosted recovery on its existing event-type-checked path, including projection lag.
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) return unknown;
    const original = result.rows[0]!;
    if (original.type === 'mcp.server_registered') return null;
    if (original.type !== 'mcp.server_published' && original.type !== 'mcp.server_unpublished') {
      return unknown;
    }
    const data = z.object({ serverId: identifier }).parse(original.data);
    return readPublication(db, silo, data.serverId, now);
  }
  try {
    return await boundedRead(read);
  } catch {
    return unknown;
  }
}

function rowOfType(rows: Row[], type: string) {
  function matches(row: Row) {
    return row.type === type;
  }
  return rows.find(matches);
}

function publicationStatus(rows: Row[], serverId: string, now: Date) {
  const policyRow = rowOfType(rows, 'policy');
  const policy = policyRow && toolPolicySchema.parse(policyRow.data);
  const intent = policy?.publication;
  if (!policy || !intent) return { status: 'disabled' };
  const published = rowOfType(rows, 'mcp.server_published');
  if (!published) return unknown;
  const withdrawn = rowOfType(rows, 'mcp.server_unpublished');
  if (withdrawn && Number(withdrawn.position) > Number(published.position)) {
    return { status: 'disabled' };
  }
  const base = { changeRef: intent.commandId, fragmentDigest: intent.fragmentDigest,
    requestedAt: published.time };
  const requested = rowOfType(rows, 'gateway.configuration_requested');
  if (!requested) {
    return { ...base, status: 'applying', stage: 'preparation', reason: 'not_prepared' };
  }
  const record = gatewayConfigurationSchema.parse(requested.data);
  function matchesServer(member: Member) {
    return member.entry.serverId === serverId && member.changeRef === intent?.commandId;
  }
  const member = record.members.find(matchesServer);
  if (!member || !currentMember(policy, record, member)) {
    return { ...base, status: 'applying', stage: 'preparation', reason: 'not_current' };
  }
  const evidence = { ...base, generation: record.generation, recordDigest: record.recordDigest };
  const observed = rowOfType(rows, 'gateway.configuration_observed');
  const observation = currentObservation(observed, requested, record);
  if (!observation) {
    return pending(evidence, 'observation', requested.time, now);
  }
  if (!exactReceipt(policy, member, observation)) {
    return pending(evidence, 'receipt', requested.time, now);
  }
  // Share the bridge's availability rule; matching receipts alone cannot enable tools.
  if (!isToolPolicyAvailable(policy, now.getTime())) {
    return { ...evidence, status: 'disabled' };
  }
  return { ...evidence, status: 'ready', configDigest: observation.configDigest,
    observedAt: observation.observedAt };
}

function currentObservation(observed: Row | undefined, requested: Row, record: Configuration) {
  if (!observed) return null;
  const observation = gatewayObservationSchema.parse(observed.data);
  if (observation.generation !== record.generation ||
      observation.recordDigest !== record.recordDigest ||
      Number(observed.position) <= Number(requested.position)) {
    return null;
  }
  return observation;
}

function currentMember(policy: ToolPolicy, record: Configuration, member: Member) {
  const { recordDigest, ...saved } = record;
  const digest = losslessJson(JSON.stringify(saved)).digest;
  const fragmentDigest = losslessJson(JSON.stringify(member.entry)).digest;
  return recordDigest === digest && member.fragmentDigest === fragmentDigest &&
    member.fragmentDigest === policy.publication?.fragmentDigest &&
    member.entry.reviewRevision === policy.reviewRevision &&
    isToolReviewCurrent(policy);
}

function exactReceipt(policy: ToolPolicy, member: Member, observation: Observation) {
  const receipt = policy.configurationObservation;
  return receipt !== undefined && receipt.serverId === policy.serverId &&
    receipt.changeRef === member.changeRef && receipt.fragmentDigest === member.fragmentDigest &&
    receipt.sourceSequence === member.sourceSequence &&
    receipt.reviewRevision === member.entry.reviewRevision &&
    receipt.generation === observation.generation && receipt.recordDigest === observation.recordDigest &&
    receipt.configDigest === observation.configDigest && receipt.processRef === observation.processRef &&
    receipt.observedAt === observation.observedAt;
}

function pending(evidence: { generation: number }, stage: string, requestedAt: string, now: Date) {
  // Report uncertainty after the delivery window, without claiming that delivery failed.
  if (now.getTime() - Date.parse(requestedAt) >= 30_000) {
    return { ...evidence, status: 'unknown', stage, reason: 'deadline' };
  }
  return { ...evidence, status: 'applying', stage, reason: 'not_observed' };
}
