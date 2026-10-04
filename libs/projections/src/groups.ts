import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

const group = z.object({ teamId: z.string(), membershipSource: z.enum(['local', 'identity_provider']).default('local') }).passthrough();
function projection(name: string, suffix: string): Projection {
  const teams = `groups${suffix}`, members = `group_members${suffix}`, access = `group_access${suffix}`;
  return { name,
    async create(db) {
      await db.query(`CREATE TABLE IF NOT EXISTS ${teams} (silo TEXT NOT NULL, group_id TEXT NOT NULL,
        name TEXT NOT NULL, membership_source TEXT NOT NULL, position BIGINT NOT NULL, PRIMARY KEY (silo, group_id))`);
      await db.query(`CREATE TABLE IF NOT EXISTS ${members} (silo TEXT NOT NULL, group_id TEXT NOT NULL,
        member_id TEXT NOT NULL, membership_source TEXT NOT NULL, PRIMARY KEY (silo, group_id, member_id))`);
      await db.query(`CREATE TABLE IF NOT EXISTS ${access} (silo TEXT NOT NULL, group_id TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, relation TEXT NOT NULL,
        PRIMARY KEY (silo, group_id, resource_type, resource_id, relation))`);
    },
    async drop(db) {
      for (const table of [members, access, teams]) await db.query(`DROP TABLE IF EXISTS ${table}`);
    },
    async apply(db, event, position) {
      if (event.type.startsWith('team.')) {
        const data = group.parse(getEventDefinition(event.type)?.dataSchema.parse(event.data));
        if (event.subject !== `team-${data.teamId}`) throw new Error('Group subject mismatch');
        if (event.type === 'team.created') {
          const { name } = z.object({ name: z.string() }).parse(event.data);
          await db.query(`INSERT INTO ${teams} VALUES ($1, $2, $3, $4, $5) ON CONFLICT (silo, group_id) DO NOTHING`, [event.silo, data.teamId, name, data.membershipSource, position]);
          return;
        }
        const { memberId } = z.object({ memberId: z.string() }).parse(event.data);
        if (event.type === 'team.member_added') await db.query(`INSERT INTO ${members} VALUES ($1, $2, $3, $4)
          ON CONFLICT (silo, group_id, member_id) DO UPDATE SET membership_source = $4`, [event.silo, data.teamId, memberId, data.membershipSource]);
        else await db.query(`DELETE FROM ${members} WHERE silo = $1 AND group_id = $2 AND member_id = $3`, [event.silo, data.teamId, memberId]);
        await db.query(`UPDATE ${teams} SET position = $3 WHERE silo = $1 AND group_id = $2`, [event.silo, data.teamId, position]);
      } else await applyAccess(db, access, event);
    },
  };
}
async function applyAccess(db: Query, table: string, event: EventEnvelope) {
  if (event.type === 'assistant.created') {
    const d = z.object({ kind: z.string(), ownerId: z.string(), assistantId: z.string() }).parse(event.data);
    if (d.kind === 'team') await db.query(`INSERT INTO ${table} VALUES ($1, $2, 'assistant', $3, 'acts_for') ON CONFLICT DO NOTHING`, [event.silo, d.ownerId, d.assistantId]);
  }
  if (event.type.startsWith('grant.')) {
    const d = z.object({ granteeId: z.string(), granteeKind: z.string().optional(), resourceType: z.string(), resourceId: z.string() }).parse(event.data);
    await db.query(`DELETE FROM ${table} WHERE silo = $1 AND group_id = $2 AND resource_type = $3 AND resource_id = $4 AND relation = 'use'`, [event.silo, d.granteeId, d.resourceType, d.resourceId]);
    if (event.type === 'grant.given' && d.granteeKind === 'team') await db.query(`INSERT INTO ${table} VALUES ($1, $2, $3, $4, 'use')`, [event.silo, d.granteeId, d.resourceType, d.resourceId]);
  }
}
export const groups = projection('groups', '');
export const replayGroups = projection('groups-replay', '_replay');

/** Membership is a source of group grants, never a conversation or personal-memory grant. */
export async function readGroups(db: Query, silo: string, groupId?: string) {
  const result = await db.query<{ group_id: string; name: string; membership_source: string; position: string }>(
    'SELECT * FROM groups WHERE silo = $1 AND ($2::text IS NULL OR group_id = $2) ORDER BY name, group_id', [silo, groupId ?? null]);
  return Promise.all(result.rows.map(async row => ({ groupId: row.group_id, name: row.name, membershipSource: row.membership_source,
    position: Number(row.position), payingGroupId: row.group_id,
    members: (await db.query<{ memberId: string; displayName: string; membershipSource: string }>(`SELECT g.member_id AS "memberId", m.display_name AS "displayName", g.membership_source AS "membershipSource"
      FROM group_members g JOIN members m ON m.silo = g.silo AND m.member_id = g.member_id
      WHERE g.silo = $1 AND g.group_id = $2 AND m.status = 'joined' ORDER BY g.member_id`, [silo, row.group_id])).rows,
    access: { source: 'group_membership', conversationAccess: false, personalMemoryAccess: false,
      grants: (await db.query<{ resourceType: string; resourceId: string; relation: string }>(`SELECT resource_type AS "resourceType", resource_id AS "resourceId", relation FROM group_access
        WHERE silo = $1 AND group_id = $2 ORDER BY resource_type, resource_id, relation`, [silo, row.group_id])).rows },
  })));
}
