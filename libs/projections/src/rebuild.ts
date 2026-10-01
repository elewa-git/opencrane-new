import type { Logger } from "@opencrane/observability";
import type { Db, Query } from "./db.ts";
import { members, replayMembers, replayMemberTables } from "./members.ts";
import { ProjectionRunner, type EventSource } from "./runner.ts";

async function removeReplay(tx: Query): Promise<void> {
  await replayMembers.drop(tx);
  await tx.query("DELETE FROM projection_events WHERE projection = $1", [
    replayMembers.name,
  ]);
  await tx.query("DELETE FROM projection_checkpoints WHERE name = $1", [
    replayMembers.name,
  ]);
}

async function rows(db: Query, table: string, order: string) {
  return (await db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
}

async function sameState(db: Query): Promise<boolean> {
  const comparisons = await Promise.all([
    Promise.all([
      rows(db, "members", "silo, member_id"),
      rows(db, replayMemberTables.members, "silo, member_id"),
    ]),
    Promise.all([
      rows(db, "member_identities", "silo, member_id"),
      rows(db, replayMemberTables.identities, "silo, member_id"),
    ]),
    Promise.all([
      rows(db, "member_changes", "silo, position"),
      rows(db, replayMemberTables.changes, "silo, position"),
    ]),
  ]);
  return comparisons.every(([current, rebuilt]) =>
    JSON.stringify(current) === JSON.stringify(rebuilt),
  );
}

async function switchTables(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("ALTER TABLE members RENAME TO members_previous");
    await tx.query(
      "ALTER TABLE member_identities RENAME TO member_identities_previous",
    );
    await tx.query(
      "ALTER TABLE member_changes RENAME TO member_changes_previous",
    );
    await tx.query(
      `ALTER TABLE ${replayMemberTables.members} RENAME TO members`,
    );
    await tx.query(
      `ALTER TABLE ${replayMemberTables.identities} RENAME TO member_identities`,
    );
    await tx.query(
      `ALTER TABLE ${replayMemberTables.changes} RENAME TO member_changes`,
    );
    await tx.query("DROP TABLE members_previous");
    await tx.query("DROP TABLE member_identities_previous");
    await tx.query("DROP TABLE member_changes_previous");
    await tx.query("DELETE FROM projection_events WHERE projection = $1", [
      members.name,
    ]);
    await tx.query(
      "UPDATE projection_events SET projection = $1 WHERE projection = $2",
      [members.name, replayMembers.name],
    );
    await tx.query("DELETE FROM projection_checkpoints WHERE name = $1", [
      members.name,
    ]);
    await tx.query(
      "UPDATE projection_checkpoints SET name = $1 WHERE name = $2",
      [members.name, replayMembers.name],
    );
    await tx.query("SELECT pg_notify('members_changed', '')");
  });
}

/** Build beside the live tables. Readers block only for the final atomic rename. */
export async function rebuildMemberProjection(
  db: Db,
  source: EventSource,
  logger: Logger,
  { verify = false }: { verify?: boolean } = {},
) {
  if (!db.lock) {
    throw new Error("Online members rebuild requires projection locking");
  }
  return db.lock(members.name, async (locked) => {
    const current = new ProjectionRunner(locked, source, logger);
    const rebuilt = new ProjectionRunner(locked, source, logger);
    const liveCheckpoint = await current.checkpoint(members);
    await locked.transaction(removeReplay);
    await rebuilt.initialise(replayMembers);
    try {
      await rebuilt.run(replayMembers, { toSequence: liveCheckpoint });
      if (verify && !(await sameState(locked))) {
        throw new Error("Rebuilt members state differs from the live projection");
      }
      const head = await source.head();
      await rebuilt.run(replayMembers, { toSequence: head });
      await switchTables(locked);
      return { previousSequence: liveCheckpoint, sequence: head, verified: verify };
    } catch (error) {
      try {
        await locked.transaction(removeReplay);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Members rebuild and cleanup failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  });
}
