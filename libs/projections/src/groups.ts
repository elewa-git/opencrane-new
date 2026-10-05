import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

const group = z.object({
  teamId: z.string(),
  membershipSource: z.enum(['local', 'identity_provider']).default('local'),
}).passthrough();

function projection(name: string, suffix: string): Projection {
  const teams = `groups${suffix}`;
  const members = `group_members${suffix}`;
  const access = `group_access${suffix}`;
  async function create(db: Query) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${teams} (
      silo TEXT NOT NULL, group_id TEXT NOT NULL, name TEXT NOT NULL,
      membership_source TEXT NOT NULL, position BIGINT NOT NULL,
      PRIMARY KEY (silo, group_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS ${members} (
      silo TEXT NOT NULL, group_id TEXT NOT NULL, member_id TEXT NOT NULL,
      membership_source TEXT NOT NULL, PRIMARY KEY (silo, group_id, member_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS ${access} (
      silo TEXT NOT NULL, group_id TEXT NOT NULL, resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL, relation TEXT NOT NULL,
      PRIMARY KEY (silo, group_id, resource_type, resource_id, relation))`);
  }
  async function drop(db: Query) {
    for (const table of [members, access, teams]) {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }
  async function apply(db: Query, event: EventEnvelope, position: number) {
    if (!event.type.startsWith('team.')) {
      await applyAccess(db, access, event);
      return;
    }
    const definition = getEventDefinition(event.type);
    const eventData = definition?.dataSchema.parse(event.data);
    const data = group.parse(eventData);
    if (event.subject !== `team-${data.teamId}`) throw new Error('Group subject mismatch');
    if (event.type === 'team.created') {
      const details = z.object({ name: z.string() }).parse(event.data);
      await db.query(`INSERT INTO ${teams} VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (silo, group_id) DO NOTHING`,
      [event.silo, data.teamId, details.name, data.membershipSource, position]);
      return;
    }
    const details = z.object({ memberId: z.string() }).parse(event.data);
    if (event.type === 'team.member_added') {
      await db.query(`INSERT INTO ${members} VALUES ($1, $2, $3, $4)
        ON CONFLICT (silo, group_id, member_id) DO UPDATE SET membership_source = $4`,
      [event.silo, data.teamId, details.memberId, data.membershipSource]);
    } else {
      await db.query(`DELETE FROM ${members}
        WHERE silo = $1 AND group_id = $2 AND member_id = $3`,
      [event.silo, data.teamId, details.memberId]);
    }
    await db.query(`UPDATE ${teams} SET position = $3 WHERE silo = $1 AND group_id = $2`,
      [event.silo, data.teamId, position]);
  }
  return { name, create, drop, apply };
}

async function applyAccess(db: Query, table: string, event: EventEnvelope) {
  if (event.type === 'assistant.created') {
    const schema = z.object({ kind: z.string(), ownerId: z.string(), assistantId: z.string() });
    const data = schema.parse(event.data);
    if (data.kind === 'team') {
      await db.query(`INSERT INTO ${table} VALUES ($1, $2, 'assistant', $3, 'acts_for')
        ON CONFLICT DO NOTHING`, [event.silo, data.ownerId, data.assistantId]);
    }
  }
  if (!event.type.startsWith('grant.')) return;
  const schema = z.object({
    granteeId: z.string(), granteeKind: z.string().optional(),
    resourceType: z.string(), resourceId: z.string(),
  });
  const data = schema.parse(event.data);
  if (event.type === 'grant.given' && data.granteeKind !== 'team') return;
  const parameters = [event.silo, data.granteeId, data.resourceType, data.resourceId];
  await db.query(`DELETE FROM ${table} WHERE silo = $1 AND group_id = $2
    AND resource_type = $3 AND resource_id = $4 AND relation = 'use'`, parameters);
  if (event.type === 'grant.given' && data.granteeKind === 'team') {
    await db.query(`INSERT INTO ${table} VALUES ($1, $2, $3, $4, 'use')`, parameters);
  }
}
export const groups = projection('groups', '');
export const replayGroups = projection('groups-replay', '_replay');

type GroupRow = {
  group_id: string; name: string; membership_source: string; position: string;
};
async function readGroupMembers(db: Query, silo: string, groupId: string) {
  const result = await db.query<{
    memberId: string; displayName: string; membershipSource: string;
  }>(`SELECT g.member_id AS "memberId", m.display_name AS "displayName",
      g.membership_source AS "membershipSource"
    FROM group_members g JOIN members m ON m.silo = g.silo AND m.member_id = g.member_id
    WHERE g.silo = $1 AND g.group_id = $2 AND m.status = 'joined' ORDER BY g.member_id`,
  [silo, groupId]);
  return result.rows;
}
async function readGroupGrants(db: Query, silo: string, groupId: string) {
  const result = await db.query<{
    resourceType: string; resourceId: string; relation: string;
  }>(`SELECT resource_type AS "resourceType", resource_id AS "resourceId", relation
    FROM group_access WHERE silo = $1 AND group_id = $2
    ORDER BY resource_type, resource_id, relation`, [silo, groupId]);
  return result.rows;
}
async function readGroup(db: Query, silo: string, row: GroupRow) {
  const members = await readGroupMembers(db, silo, row.group_id);
  const grants = await readGroupGrants(db, silo, row.group_id);
  return {
    groupId: row.group_id, name: row.name, membershipSource: row.membership_source,
    position: Number(row.position), payingGroupId: row.group_id, members,
    access: {
      source: 'group_membership', conversationAccess: false, personalMemoryAccess: false, grants,
    },
  };
}

/** Group grants never confer conversation or personal-memory access. */
export async function readGroups(db: Query, silo: string, groupId?: string) {
  const result = await db.query<GroupRow>(
    `SELECT * FROM groups WHERE silo = $1 AND ($2::text IS NULL OR group_id = $2)
      ORDER BY name, group_id`, [silo, groupId ?? null]);
  function readRow(row: GroupRow) {
    return readGroup(db, silo, row);
  }
  const pendingGroups = result.rows.map(readRow);
  return Promise.all(pendingGroups);
}
