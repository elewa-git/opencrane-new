import { createHash } from 'node:crypto';
import { egressDestinationDataSchema, type EgressRule }
  from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

export function egressGrantStream(silo: string, rule: EgressRule) {
  const subjectDigest = createHash('sha256');
  subjectDigest.update(JSON.stringify([silo, rule.scope, rule.subjectId]));
  const destinationDigest = createHash('sha256');
  destinationDigest.update(JSON.stringify([rule.host, rule.port]));
  return `egress-grant-${subjectDigest.digest('hex')}-${destinationDigest.digest('hex')}`;
}
type RuleState = EgressRule & { silo: string; allowed: boolean };
// Check policy agreement only. Membership, live work and dispatch checks still decide admission.
export function egressRulesAllow(rules: readonly RuleState[], silo: string,
  requesterId: string, assistantId: string, destination: { host: string; port: number }) {
  const required = [['silo', silo], ['person', requesterId], ['assistant', assistantId]];
  for (const [scope, subjectId] of required) {
    function matchesRule(rule: RuleState) {
      return rule.silo === silo && rule.scope === scope && rule.subjectId === subjectId &&
        rule.host === destination.host && rule.port === destination.port && rule.allowed;
    }
    if (!rules.some(matchesRule)) return false;
  }
  return true;
}
export const egressPolicy: Projection = {
  name: 'egress-policy',
  async create(db) {
    await db.query(`CREATE TABLE IF NOT EXISTS egress_policy (
      silo TEXT NOT NULL, subject TEXT NOT NULL, data JSONB NOT NULL,
      allowed BOOLEAN NOT NULL, event_id TEXT NOT NULL, sequence BIGINT NOT NULL,
      event_time TEXT NOT NULL, command_id TEXT NOT NULL, PRIMARY KEY (silo, subject))`);
  },
  async drop(db) {
    await db.query('DROP TABLE IF EXISTS egress_policy');
  },
  async apply(db, event, position) {
    if (!['egress.destination_allowed', 'egress.destination_revoked'].includes(event.type)) return;
    const data = egressDestinationDataSchema.parse(event.data);
    if (event.subject !== egressGrantStream(event.silo, data) ||
        (data.scope === 'silo' && data.subjectId !== event.silo)) {
      throw new Error('Wrong egress rule stream');
    }
    const allowed = event.type === 'egress.destination_allowed';
    await db.query(`INSERT INTO egress_policy VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (silo, subject) DO UPDATE SET data = EXCLUDED.data,
        allowed = EXCLUDED.allowed, event_id = EXCLUDED.event_id, sequence = EXCLUDED.sequence,
        event_time = EXCLUDED.event_time, command_id = EXCLUDED.command_id
      WHERE egress_policy.sequence < EXCLUDED.sequence`,
    [event.silo, event.subject, JSON.stringify(data), allowed, event.id, position,
      event.time, event.commandId]);
  },
};
export async function readEgressRule(db: Query, silo: string, rule: EgressRule) {
  const result = await db.query<{ data: unknown; allowed: boolean; sequence: string;
    eventId: string; time: string; commandId: string }>(
    `SELECT data, allowed, sequence, event_id AS "eventId", event_time AS time,
      command_id AS "commandId" FROM egress_policy WHERE silo = $1 AND subject = $2`,
    [silo, egressGrantStream(silo, rule)]);
  const row = result.rows[0];
  if (!row) return undefined;
  return { ...egressDestinationDataSchema.parse(row.data), silo, allowed: row.allowed,
    sequence: Number(row.sequence), eventId: row.eventId, time: row.time, commandId: row.commandId };
}
