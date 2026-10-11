import type { Logger } from "@opencrane/observability";
import { setTimeout as delay } from "node:timers/promises";
import type { Db, Query } from "./db.ts";
import {
  mcpCatalogue,
  replayMcpCatalogue,
  replayMcpCatalogueTables,
} from "./mcp-catalogue.ts";
import { members, replayMembers, replayMemberTables } from "./members.ts";
import { computers, replayComputers, replayComputersTable } from './computers.ts';
import { ProjectionRunner, type EventSource } from "./runner.ts";

async function removeReplay(tx: Query): Promise<void> {
  await replayMembers.drop(tx);
  await tx.query("DELETE FROM projection_events WHERE projection = $1", [
    replayMembers.name,
  ]);
  await tx.query("DELETE FROM projection_checkpoints WHERE name = $1", [
    replayMembers.name,
  ]);
  await tx.query("DELETE FROM projection_generations WHERE name = $1", [
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
  comparisons.push(await Promise.all([
    rows(db, 'silo_ownership', 'silo'),
    rows(db, replayMemberTables.ownership, 'silo'),
  ]));
  comparisons.push(await Promise.all([
    rows(db, 'inventory_inputs', 'silo, subject, link_kind, link_id'),
    rows(db, replayMemberTables.inventory, 'silo, subject, link_kind, link_id'),
  ]));
  return comparisons.every(([current, rebuilt]) =>
    JSON.stringify(current) === JSON.stringify(rebuilt),
  );
}

async function switchTables(db: Db, changed: boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '250ms'");
        // Identity readers take these live tables in this order.
        await tx.query(`LOCK TABLE member_identities, members, member_changes,
          silo_ownership, inventory_inputs,
          ${replayMemberTables.identities}, ${replayMemberTables.members}, ${replayMemberTables.changes},
          ${replayMemberTables.ownership}, ${replayMemberTables.inventory}
          IN ACCESS EXCLUSIVE MODE`);
        // Keep the live table objects so their owners and grants do not change.
        await tx.query(`TRUNCATE member_identities, members, member_changes,
          silo_ownership, inventory_inputs`);
        await tx.query(`INSERT INTO members SELECT * FROM ${replayMemberTables.members}`);
        await tx.query(`INSERT INTO member_identities SELECT * FROM ${replayMemberTables.identities}`);
        await tx.query(`INSERT INTO member_changes SELECT * FROM ${replayMemberTables.changes}`);
        await tx.query(`INSERT INTO silo_ownership SELECT * FROM ${replayMemberTables.ownership}`);
        await tx.query(`INSERT INTO inventory_inputs SELECT * FROM ${replayMemberTables.inventory}`);
        await replayMembers.drop(tx);
        await tx.query("DELETE FROM projection_events WHERE projection = $1", [members.name]);
        await tx.query("UPDATE projection_events SET projection = $1 WHERE projection = $2", [members.name, replayMembers.name]);
        await tx.query("DELETE FROM projection_checkpoints WHERE name = $1", [members.name]);
        await tx.query("UPDATE projection_checkpoints SET name = $1 WHERE name = $2", [members.name, replayMembers.name]);
        await tx.query("DELETE FROM projection_generations WHERE name = $1", [replayMembers.name]);
        if (changed) {
          await tx.query("UPDATE projection_generations SET generation = generation + 1 WHERE name = $1", [members.name]);
        }
        await tx.query("SELECT pg_notify('members_changed', '')");
      });
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "55P03") || attempt === 3) throw error;
      await delay(50 * attempt);
    }
  }
}

/** Build beside the live tables. Readers block only for the final atomic replacement. */
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
    await current.initialise(members);
    const liveCheckpoint = await current.checkpoint(members);
    await locked.transaction(removeReplay);
    await rebuilt.initialise(replayMembers);
    try {
      await rebuilt.run(replayMembers, { toSequence: liveCheckpoint });
      const unchanged = await sameState(locked);
      if (verify && !unchanged) {
        throw new Error("Rebuilt members state differs from the live projection");
      }
      const head = await source.head();
      await rebuilt.run(replayMembers, { toSequence: head });
      await switchTables(locked, !unchanged);
      return { previousSequence: liveCheckpoint, sequence: head, verified: verify, changed: !unchanged };
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

async function removeMcpReplay(tx: Query): Promise<void> {
  await replayMcpCatalogue.drop(tx);
  await tx.query("DELETE FROM projection_events WHERE projection = $1", [
    replayMcpCatalogue.name,
  ]);
  await tx.query("DELETE FROM projection_checkpoints WHERE name = $1", [
    replayMcpCatalogue.name,
  ]);
  await tx.query("DELETE FROM projection_generations WHERE name = $1", [
    replayMcpCatalogue.name,
  ]);
}

async function sameMcpState(db: Query): Promise<boolean> {
  const comparisons = await Promise.all([
    Promise.all([
      rows(db, "mcp_catalogue", "silo, server_id"),
      rows(db, replayMcpCatalogueTables.catalogue, "silo, server_id"),
    ]),
    Promise.all([
      rows(db, "mcp_tool_modes", "silo, server_id, tool_name"),
      rows(db, replayMcpCatalogueTables.toolModes, "silo, server_id, tool_name"),
    ]),
  ]);
  return comparisons.every(([current, rebuilt]) =>
    JSON.stringify(current) === JSON.stringify(rebuilt),
  );
}

async function switchMcpTables(db: Db, changed: boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '250ms'");
        await tx.query(`LOCK TABLE mcp_catalogue, mcp_tool_modes,
          ${replayMcpCatalogueTables.catalogue}, ${replayMcpCatalogueTables.toolModes}
          IN ACCESS EXCLUSIVE MODE`);
        await tx.query("TRUNCATE mcp_catalogue, mcp_tool_modes");
        await tx.query(`INSERT INTO mcp_catalogue SELECT * FROM ${replayMcpCatalogueTables.catalogue}`);
        await tx.query(`INSERT INTO mcp_tool_modes SELECT * FROM ${replayMcpCatalogueTables.toolModes}`);
        await replayMcpCatalogue.drop(tx);
        await tx.query("DELETE FROM projection_events WHERE projection = $1", [mcpCatalogue.name]);
        await tx.query("UPDATE projection_events SET projection = $1 WHERE projection = $2", [
          mcpCatalogue.name,
          replayMcpCatalogue.name,
        ]);
        await tx.query("DELETE FROM projection_checkpoints WHERE name = $1", [mcpCatalogue.name]);
        await tx.query("UPDATE projection_checkpoints SET name = $1 WHERE name = $2", [
          mcpCatalogue.name,
          replayMcpCatalogue.name,
        ]);
        await tx.query("DELETE FROM projection_generations WHERE name = $1", [replayMcpCatalogue.name]);
        // Like members: a repair that changed state starts a new generation, so readers reload.
        if (changed) {
          await tx.query("UPDATE projection_generations SET generation = generation + 1 WHERE name = $1", [mcpCatalogue.name]);
        }
      });
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "55P03") || attempt === 3) throw error;
      await delay(50 * attempt);
    }
  }
}

/** Build the MCP catalogue beside the live tables and replace their contents atomically. */
export async function rebuildMcpCatalogueProjection(
  db: Db,
  source: EventSource,
  logger: Logger,
  { verify = false }: { verify?: boolean } = {},
) {
  if (!db.lock) {
    throw new Error("Online MCP catalogue rebuild requires projection locking");
  }
  return db.lock(mcpCatalogue.name, async (locked) => {
    const current = new ProjectionRunner(locked, source, logger);
    const rebuilt = new ProjectionRunner(locked, source, logger);
    await current.initialise(mcpCatalogue);
    const liveCheckpoint = await current.checkpoint(mcpCatalogue);
    await locked.transaction(removeMcpReplay);
    await rebuilt.initialise(replayMcpCatalogue);
    try {
      await rebuilt.run(replayMcpCatalogue, { toSequence: liveCheckpoint });
      const unchanged = await sameMcpState(locked);
      if (verify && !unchanged) {
        throw new Error("Rebuilt MCP catalogue state differs from the live projection");
      }
      const head = await source.head();
      await rebuilt.run(replayMcpCatalogue, { toSequence: head });
      await switchMcpTables(locked, !unchanged);
      return { previousSequence: liveCheckpoint, sequence: head, verified: verify, changed: !unchanged };
    } catch (error) {
      try {
        await locked.transaction(removeMcpReplay);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "MCP catalogue rebuild and cleanup failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  });
}

async function removeComputerReplay(tx: Query): Promise<void> {
  await replayComputers.drop(tx);
  await tx.query("DELETE FROM projection_events WHERE projection = $1", [replayComputers.name]);
  await tx.query("DELETE FROM projection_checkpoints WHERE name = $1", [replayComputers.name]);
  await tx.query("DELETE FROM projection_generations WHERE name = $1", [replayComputers.name]);
}

/** Rebuild the computer read model. Reactions and Kubernetes are not loaded here. */
export async function rebuildComputersProjection(
  db: Db, source: EventSource, logger: Logger, { verify = false }: { verify?: boolean } = {},
) {
  if (!db.lock) throw new Error('Online computers rebuild requires projection locking');
  return db.lock(computers.name, async (locked) => {
    const current = new ProjectionRunner(locked, source, logger);
    const rebuilt = new ProjectionRunner(locked, source, logger);
    await current.initialise(computers);
    const liveCheckpoint = await current.checkpoint(computers);
    await locked.transaction(removeComputerReplay);
    await rebuilt.initialise(replayComputers);
    try {
      await rebuilt.run(replayComputers, { toSequence: liveCheckpoint });
      const unchanged = JSON.stringify(await rows(locked, 'computers', 'silo, assistant_id'))
        === JSON.stringify(await rows(locked, replayComputersTable, 'silo, assistant_id'));
      if (verify && !unchanged) throw new Error('Rebuilt computers state differs from the live projection');
      const head = await source.head();
      await rebuilt.run(replayComputers, { toSequence: head });
      await locked.transaction(async (tx) => {
        await tx.query('SET LOCAL lock_timeout = \'250ms\'');
        await tx.query(`LOCK TABLE computers, ${replayComputersTable} IN ACCESS EXCLUSIVE MODE`);
        await tx.query('TRUNCATE computers');
        await tx.query(`INSERT INTO computers SELECT * FROM ${replayComputersTable}`);
        await replayComputers.drop(tx);
        await tx.query('DELETE FROM projection_events WHERE projection = $1', [computers.name]);
        await tx.query('UPDATE projection_events SET projection = $1 WHERE projection = $2', [computers.name, replayComputers.name]);
        await tx.query('DELETE FROM projection_checkpoints WHERE name = $1', [computers.name]);
        await tx.query('UPDATE projection_checkpoints SET name = $1 WHERE name = $2', [computers.name, replayComputers.name]);
        await tx.query('DELETE FROM projection_generations WHERE name = $1', [replayComputers.name]);
        if (!unchanged) await tx.query('UPDATE projection_generations SET generation = generation + 1 WHERE name = $1', [computers.name]);
      });
      return { previousSequence: liveCheckpoint, sequence: head, verified: verify, changed: !unchanged };
    } catch (error) {
      await locked.transaction(removeComputerReplay).catch((cleanupError: unknown) => {
        throw new AggregateError([error, cleanupError], 'Computers rebuild and cleanup failed');
      });
      throw error;
    }
  });
}
