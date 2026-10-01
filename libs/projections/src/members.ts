import {
  memberInvitedDataSchema,
  memberJoinedDataSchema,
  getEventDefinition,
  type EventEnvelope,
} from "@opencrane/events";
import type { Query } from "./db.ts";
import type { Projection } from "./runner.ts";

interface MemberTables {
  members: string;
  identities: string;
  changes: string;
}

const live = {
  members: "members",
  identities: "member_identities",
  changes: "member_changes",
} satisfies MemberTables;
export const replayMemberTables = {
  members: "members_replay",
  identities: "member_identities_replay",
  changes: "member_changes_replay",
} satisfies MemberTables;

function field(data: unknown, name: string): string {
  if (typeof data !== "object" || data === null || !(name in data)) {
    throw new Error("Missing member field");
  }
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== "string") {
    throw new Error("Invalid member field");
  }
  return value;
}

async function applyMember(
  tables: MemberTables,
  db: Query,
  event: EventEnvelope,
  position: number,
): Promise<void> {
  if (
    ![
      "member.invited",
      "member.joined",
      "member.removed",
      "member.role_changed",
    ].includes(event.type)
  ) {
    return;
  }
  const data: unknown = getEventDefinition(event.type)?.dataSchema.parse(
    event.data,
  );
  const id = field(data, "memberId");
  if (event.subject !== `member-${id}`) {
    throw new Error("Member subject mismatch");
  }
  await applyIdentity(tables, db, event, data, id);
  if (event.type === "member.removed") {
    await db.query(
      `UPDATE ${tables.members} SET status = $3 WHERE silo = $1 AND member_id = $2`,
      [event.silo, id, "removed"],
    );
  } else if (event.type === "member.role_changed") {
    await db.query(
      `UPDATE ${tables.members} SET role = $3 WHERE silo = $1 AND member_id = $2`,
      [event.silo, id, field(data, "newRole")],
    );
  } else {
    const joined = event.type === "member.joined";
    await db.query(
      `INSERT INTO ${tables.members} VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (silo, member_id) DO UPDATE SET email = $3, display_name = $4, role = $5, status = $6`,
      [
        event.silo,
        id,
        field(data, "email"),
        joined ? field(data, "displayName") : null,
        field(data, "role"),
        joined ? "joined" : "invited",
      ],
    );
  }
  await db.query(
    `INSERT INTO ${tables.changes}
      SELECT silo, $3, jsonb_build_object('memberId', member_id, 'email', email,
        'displayName', display_name, 'role', role, 'status', status)
      FROM ${tables.members} WHERE silo = $1 AND member_id = $2`,
    [event.silo, id, position],
  );
  // PostgreSQL delivers this only after the row and checkpoint commit.
  await db.query("SELECT pg_notify('members_changed', $1)", [event.silo]);
}

async function applyIdentity(
  tables: MemberTables,
  db: Query,
  event: EventEnvelope,
  data: unknown,
  id: string,
): Promise<void> {
  if (event.type === "member.invited") {
    const invitation = memberInvitedDataSchema.parse(data);
    await db.query(
      `DELETE FROM ${tables.identities} WHERE silo = $1 AND member_id = $2`,
      [event.silo, id],
    );
    if (invitation.invitedIdentity) {
      await db.query(
        `INSERT INTO ${tables.identities} VALUES ($1, $2, $3, $4, $5)`,
        [event.silo, id, invitation.invitedIdentity.issuer,
          invitation.invitedIdentity.sub, invitation.invitationId],
      );
    }
  }
  if (event.type === "member.joined") {
    const joined = memberJoinedDataSchema.parse(data);
    await db.query(
      `DELETE FROM ${tables.identities} WHERE silo = $1 AND member_id = $2
      AND (invitation_id IS DISTINCT FROM $3 OR sub IS DISTINCT FROM $4)`,
      [event.silo, id, joined.invitationId ?? null, event.principal?.id ?? null],
    );
  }
}

function memberProjection(name: string, tables: MemberTables): Projection {
  return {
    name,
    async create(db) {
      await db.query(`CREATE TABLE IF NOT EXISTS ${tables.members} (
        silo TEXT NOT NULL, member_id TEXT NOT NULL, email TEXT NOT NULL,
        display_name TEXT, role TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY (silo, member_id))`);
      await db.query(`CREATE TABLE IF NOT EXISTS ${tables.identities} (
        silo TEXT NOT NULL, member_id TEXT NOT NULL, issuer TEXT NOT NULL,
        sub TEXT NOT NULL, invitation_id TEXT NOT NULL, PRIMARY KEY (silo, member_id))`);
      await db.query(`CREATE TABLE IF NOT EXISTS ${tables.changes} (
        silo TEXT NOT NULL, position BIGINT NOT NULL, member JSONB NOT NULL,
        PRIMARY KEY (silo, position))`);
    },
    async drop(db) {
      await db.query(`DROP TABLE IF EXISTS ${tables.changes}`);
      await db.query(`DROP TABLE IF EXISTS ${tables.identities}`);
      await db.query(`DROP TABLE IF EXISTS ${tables.members}`);
    },
    apply: (db, event, position) => applyMember(tables, db, event, position),
  };
}

/** Invited rows are pending invitations, never an authorisation grant. Removed rows are retained for display. */
export const members = memberProjection("members", live);
export const replayMembers = memberProjection(
  "members-replay",
  replayMemberTables,
);
