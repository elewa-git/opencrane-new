import {
  legacyMemberRole, ownershipSeededSchema, ownershipTransferredSchema,
  ownershipSteppedDownSchema, ownershipConfirmedSchema,
  memberInvitedDataSchema,
  siloOwnerBootstrappedDataSchema,
  memberJoinedDataSchema,
  getEventDefinition,
  type EventEnvelope,
} from "@opencrane/events";
import type { Query } from "./db.ts";
import type { Projection } from "./runner.ts";

import { applyInventoryInput, createInventoryInputs } from './inventory-inputs.ts';

interface MemberTables {
  members: string;
  identities: string;
  changes: string;
  ownership: string;
  inventory: string;
}

const live = {
  members: "members",
  identities: "member_identities",
  changes: "member_changes",
  ownership: "silo_ownership",
  inventory: "inventory_inputs",
} satisfies MemberTables;
export const replayMemberTables = {
  members: "members_replay",
  identities: "member_identities_replay",
  changes: "member_changes_replay",
  ownership: "silo_ownership_replay",
  inventory: "inventory_inputs_replay",
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
  if (event.type.startsWith('ownership.') || event.type === 'member.ownership_confirmed') {
    await applyOwnership(tables, db, event, position);
    return;
  }
  if (
    ![
      "member.invited",
      "member.joined",
      "silo.owner_bootstrapped",
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
  if (event.type === 'member.invited') {
    // Reinviting an active member grants nothing and must preserve their identity and role.
    const current = await db.query<{ status: string }>(
      `SELECT status FROM ${tables.members} WHERE silo = $1 AND member_id = $2`,
      [event.silo, id]);
    if (current.rows[0]?.status === 'joined') {
      return;
    }
  } else {
    const noEffect = await refuseOwnerEdit(tables, db, event, id);
    if (noEffect) {
      return;
    }
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
    const joined = event.type === "member.joined" || event.type === "silo.owner_bootstrapped";
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
  if (event.type === 'silo.owner_bootstrapped') {
    const owner = siloOwnerBootstrappedDataSchema.parse(data);
    if (event.principal?.kind !== 'human' || event.principal.id !== owner.identity.sub) {
      throw new Error('Bootstrap identity mismatch');
    }
    await db.query(`INSERT INTO ${tables.identities} VALUES ($1, $2, $3, $4, $5)`,
      [event.silo, id, owner.identity.issuer, owner.identity.sub, event.id]);
  }
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
    await applyJoinedIdentity(tables, db, event, data, id);
  }
}

async function applyJoinedIdentity(tables: MemberTables, db: Query, event: EventEnvelope,
  data: unknown, id: string): Promise<void> {
  const joined = memberJoinedDataSchema.parse(data);
  await db.query(
    `DELETE FROM ${tables.identities} WHERE silo = $1 AND member_id = $2
    AND (invitation_id IS DISTINCT FROM $3 OR sub IS DISTINCT FROM $4)`,
    [event.silo, id, joined.invitationId ?? null, event.principal?.id ?? null],
  );
  if (joined.identity) {
    if (event.principal?.kind !== 'human' || event.principal.id !== joined.identity.sub) {
      throw new Error('Join identity mismatch');
    }
    await db.query(`INSERT INTO ${tables.identities} VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (silo, member_id) DO UPDATE
      SET issuer = $3, sub = $4, invitation_id = $5`,
      [event.silo, id, joined.identity.issuer, joined.identity.sub,
        joined.invitationId ?? null]);
  }
}

function memberProjection(name: string, tables: MemberTables): Projection {
  return {
    name,
    async create(db) {
      await createInventoryInputs(db, tables.inventory);
      await db.query(`CREATE TABLE IF NOT EXISTS ${tables.ownership} (
        silo TEXT PRIMARY KEY, owners JSONB NOT NULL)`);
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
      await db.query(`DROP TABLE IF EXISTS ${tables.inventory}_backfill`);
      await db.query(`DROP TABLE IF EXISTS ${tables.inventory}`);
      await db.query(`DROP TABLE IF EXISTS ${tables.ownership}`);
      await db.query(`DROP TABLE IF EXISTS ${tables.changes}`);
      await db.query(`DROP TABLE IF EXISTS ${tables.identities}`);
      await db.query(`DROP TABLE IF EXISTS ${tables.members}`);
    },
    async completeRebuild(db) {
      // Mark the index complete only after the runner has read every event from the start.
      await db.query(`INSERT INTO ${tables.inventory}_backfill VALUES (1)
        ON CONFLICT DO NOTHING`);
    },
    async apply(db, event, position) {
      await applyInventoryInput(db, tables.inventory, event, position);
      await applyMember(tables, db, event, position);
    },
  };
}

/** Invitations grant no authority. Removed rows are retained for display. */
export const members = memberProjection("members", live);
export const replayMembers = memberProjection(
  "members-replay",
  replayMemberTables,
);

async function applyOwnership(tables: MemberTables, db: Query,
  event: EventEnvelope, position: number) {
  const confirmation = event.type === 'member.ownership_confirmed';
  requireOwnershipSubject(event, confirmation);
  const current = await db.query<{ owners: string[] }>(
    `SELECT owners FROM ${tables.ownership} WHERE silo = $1`, [event.silo]);
  let owners = current.rows[0]?.owners;
  if (event.type === 'ownership.seeded') {
    if (owners) {
      throw new Error('Ownership already seeded');
    }
    owners = ownershipSeededSchema.parse(event.data).ownerIds;
  } else {
    if (!owners) {
      throw new Error('Ownership migration required');
    }
    const memberId = field(event.data, 'memberId');
    let role: string;
    if (confirmation) {
      await confirmProjectedOwner(tables, db, event, memberId, owners);
      role = 'owner';
    } else if (event.type === 'ownership.transferred') {
      const transfer = ownershipTransferredSchema.parse(event.data);
      if (transfer.awaitingConfirmation) return;
      if (!owners.includes(transfer.transferredBy)) {
        throw new Error('Owner required');
      }
      owners.push(memberId);
      role = 'owner';
    } else {
      ownershipSteppedDownSchema.parse(event.data);
      if (!owners.includes(memberId) || owners.length < 2) {
        throw new Error('At least one owner must remain');
      }
      const remaining: string[] = [];
      for (const ownerId of owners) {
        if (ownerId !== memberId) {
          remaining.push(ownerId);
        }
      }
      owners = remaining;
      role = 'admin';
    }
    await db.query(`UPDATE ${tables.members} SET role = $3 WHERE silo = $1 AND member_id = $2`,
      [event.silo, memberId, role]);
    await db.query(`INSERT INTO ${tables.changes}
      SELECT silo, $3, jsonb_build_object('memberId', member_id, 'email', email,
        'displayName', display_name, 'role', role, 'status', status)
      FROM ${tables.members} WHERE silo = $1 AND member_id = $2`,
      [event.silo, memberId, position]);
    await db.query("SELECT pg_notify('members_changed', $1)", [event.silo]);
  }
  await db.query(`INSERT INTO ${tables.ownership} VALUES ($1, $2)
    ON CONFLICT (silo) DO UPDATE SET owners = $2`, [event.silo, JSON.stringify(owners)]);
}

async function refuseOwnerEdit(tables: MemberTables, db: Query,
  event: EventEnvelope, id: string) {
  const ownership = await db.query<{ owners: string[] }>(
    `SELECT owners FROM ${tables.ownership} WHERE silo = $1`, [event.silo]);
  const owners = ownership.rows[0]?.owners;
  const nextRole = legacyMemberRole(event);
  if (owners?.includes(id) && event.type === 'member.role_changed'
    && (nextRole === 'member' || nextRole === 'admin')) {
    // Record the event without changing the owner's role or blocking later events.
    return true;
  }
  if (owners && (owners.includes(id) || nextRole === 'owner')) {
    throw new Error('Owner changes require the ownership stream');
  }
  return false;
}

function requireOwnershipSubject(event: EventEnvelope, confirmation: boolean) {
  if (!confirmation && event.subject !== `ownership-${event.silo}`) {
    throw new Error('Ownership subject mismatch');
  }
}

async function confirmProjectedOwner(tables: MemberTables, db: Query,
  event: EventEnvelope, memberId: string, owners: string[]) {
  ownershipConfirmedSchema.parse(event.data);
  if (event.subject !== `member-${memberId}`) throw new Error('Member subject mismatch');
  const member = await db.query<{ status: string }>(
    `SELECT status FROM ${tables.members} WHERE silo = $1 AND member_id = $2`,
    [event.silo, memberId]);
  if (member.rows[0]?.status !== 'joined') throw new Error('Active successor required');
  if (!owners.includes(memberId)) owners.push(memberId);
}
