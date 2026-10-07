import { assistantCreatedDataSchema, getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

export type ModelGrantState = {
  granteeKind: 'member' | 'team' | 'assistant';
  granteeId: string;
  displayName: string;
  state: 'granted' | 'revoked';
  eventId: string;
  eventTime: string | Date;
  position: number;
};

function projection(name: string, suffix: string): Projection {
  const grants = `model_access_grants${suffix}`;
  const assistants = `model_access_assistants${suffix}`;

  async function create(db: Query) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${grants} (
      silo TEXT NOT NULL, model_id TEXT NOT NULL, grantee_kind TEXT NOT NULL,
      grantee_id TEXT NOT NULL, state TEXT NOT NULL, event_id TEXT NOT NULL,
      event_time TIMESTAMPTZ NOT NULL, position BIGINT NOT NULL,
      PRIMARY KEY (silo, model_id, grantee_kind, grantee_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS ${assistants} (
      silo TEXT NOT NULL, assistant_id TEXT NOT NULL, name TEXT,
      PRIMARY KEY (silo, assistant_id))`);
  }

  async function drop(db: Query) {
    await db.query(`DROP TABLE IF EXISTS ${grants}`);
    await db.query(`DROP TABLE IF EXISTS ${assistants}`);
  }

  async function apply(db: Query, event: EventEnvelope, position: number) {
    if (event.type === 'assistant.created') {
      const data = assistantCreatedDataSchema.parse(event.data);
      if (event.subject !== `assistant-${data.assistantId}`) {
        throw new Error('Assistant subject mismatch');
      }
      await db.query(`INSERT INTO ${assistants} VALUES ($1, $2, $3)
        ON CONFLICT (silo, assistant_id) DO UPDATE SET name = EXCLUDED.name`,
      [event.silo, data.assistantId, data.name ?? null]);
      return;
    }
    if (event.type !== 'grant.given' && event.type !== 'grant.revoked') return;

    const definition = getEventDefinition(event.type);
    if (!definition) throw new Error('Unknown grant event');
    const parsed = z.record(z.string(), z.unknown()).parse(
      definition.dataSchema.parse(event.data));
    const resourceType = z.string().parse(parsed['resourceType']);
    const resourceId = z.string().parse(parsed['resourceId']);
    const granteeId = z.string().parse(parsed['granteeId']);
    if (resourceType !== 'model') return;

    let kinds: ('member' | 'team' | 'assistant')[];
    if (event.type === 'grant.given') {
      kinds = [z.enum(['member', 'team', 'assistant']).parse(parsed['granteeKind'])];
    } else {
      const granteeKind = parsed['granteeKind'] === undefined ? undefined
        : z.enum(['member', 'team', 'assistant']).parse(parsed['granteeKind']);
      kinds = await kindsForRevocation(db, grants, event.silo, resourceId, granteeId,
        granteeKind);
    }
    const state = event.type === 'grant.given' ? 'granted' : 'revoked';
    for (const granteeKind of kinds) {
      await db.query(`INSERT INTO ${grants} VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (silo, model_id, grantee_kind, grantee_id) DO UPDATE SET
          state = EXCLUDED.state, event_id = EXCLUDED.event_id,
          event_time = EXCLUDED.event_time, position = EXCLUDED.position`,
      [event.silo, resourceId, granteeKind, granteeId, state,
        event.id, event.time, position]);
    }
  }

  return { name, create, drop, apply };
}

async function kindsForRevocation(db: Query, table: string, silo: string, modelId: string,
  granteeId: string, granteeKind?: 'member' | 'team' | 'assistant') {
  if (granteeKind) return [granteeKind];
  const result = await db.query<{ grantee_kind: 'member' | 'team' | 'assistant' }>(
    `SELECT grantee_kind FROM ${table}
      WHERE silo = $1 AND model_id = $2 AND grantee_id = $3`,
    [silo, modelId, granteeId]);
  function kindForRow(row: { grantee_kind: 'member' | 'team' | 'assistant' }) {
    return row.grantee_kind;
  }
  return result.rows.map(kindForRow);
}

export const modelAccess = projection('model-access', '');
export const replayModelAccess = projection('model-access-replay', '_replay');

export async function readModelGrantRows(db: Query, silo: string, modelId: string) {
  const result = await db.query<ModelGrantState>(
    `SELECT a.grantee_kind AS "granteeKind", a.grantee_id AS "granteeId",
      CASE a.grantee_kind
        WHEN 'member' THEN COALESCE(m.display_name, a.grantee_id)
        WHEN 'team' THEN COALESCE(g.name, a.grantee_id)
        ELSE COALESCE(x.name, a.grantee_id)
      END AS "displayName",
      a.state, a.event_id AS "eventId", a.event_time AS "eventTime", a.position
      FROM model_access_grants a
      LEFT JOIN members m ON a.grantee_kind = 'member'
        AND m.silo = a.silo AND m.member_id = a.grantee_id
      LEFT JOIN groups g ON a.grantee_kind = 'team'
        AND g.silo = a.silo AND g.group_id = a.grantee_id
      LEFT JOIN model_access_assistants x ON a.grantee_kind = 'assistant'
        AND x.silo = a.silo AND x.assistant_id = a.grantee_id
      WHERE a.silo = $1 AND a.model_id = $2
      ORDER BY a.grantee_kind, a.grantee_id`, [silo, modelId]);
  function toPublicRow(row: ModelGrantState): ModelGrantState {
    return {
      ...row,
      eventTime: new Date(row.eventTime).toISOString(),
      position: Number(row.position),
    };
  }
  return result.rows.map(toPublicRow);
}

export async function readModelAccessCandidates(db: Query, silo: string,
  kind: 'member' | 'team' | 'assistant', after: string | undefined, limit: number) {
  if (kind === 'member') return memberCandidates(db, silo, after, limit);
  if (kind === 'team') return teamCandidates(db, silo, after, limit);
  return assistantCandidates(db, silo, after, limit);
}

async function memberCandidates(db: Query, silo: string, after: string | undefined, limit: number) {
  const result = await db.query<{ id: string; displayName: string }>(
    `SELECT member_id AS id, COALESCE(display_name, member_id) AS "displayName"
      FROM members WHERE silo = $1 AND status = 'joined' AND member_id > $2
      ORDER BY member_id LIMIT $3`, [silo, after ?? '', limit + 1]);
  return result.rows;
}

async function teamCandidates(db: Query, silo: string, after: string | undefined, limit: number) {
  const result = await db.query<{ id: string; displayName: string; memberCount: number }>(
    `WITH selected_groups AS (
      SELECT group_id, name FROM groups WHERE silo = $1 AND group_id > $2
        ORDER BY group_id LIMIT $3
    )
    SELECT g.group_id AS id, g.name AS "displayName", COUNT(m.member_id)::int AS "memberCount"
      FROM selected_groups g LEFT JOIN group_members gm
        ON gm.silo = $1 AND gm.group_id = g.group_id
      LEFT JOIN members m ON m.silo = gm.silo AND m.member_id = gm.member_id
        AND m.status = 'joined'
      GROUP BY g.group_id, g.name ORDER BY g.group_id`,
    [silo, after ?? '', limit + 1]);
  return result.rows;
}

async function assistantCandidates(db: Query, silo: string, after: string | undefined, limit: number) {
  const result = await db.query<{ id: string; displayName: string }>(
    `SELECT assistant_id AS id, COALESCE(name, assistant_id) AS "displayName"
      FROM model_access_assistants WHERE silo = $1 AND assistant_id > $2
      ORDER BY assistant_id LIMIT $3`, [silo, after ?? '', limit + 1]);
  return result.rows;
}
