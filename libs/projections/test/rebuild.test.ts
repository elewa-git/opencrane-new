import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { createLogger } from "@opencrane/observability";
import {
  members,
  pgDb,
  ProjectionRunner,
  rebuildMemberProjection,
  type EventSource,
} from "../src/index.ts";
import { database } from "./database.ts";

it.skipIf(!process.env["PG_TEST_URL"])(
  "leaves the live members projection untouched and removes shadow tables after failure",
  async () => {
    const nats = await natsFixture();
    const storage = await database("pg");
    const logger = createLogger("rebuild-failure", { level: "silent" });
    try {
      const result = await nats.store.append({ event: event("join"), expectedSequence: 0 });
      expect(result.status).toBe("appended");
      const runner = new ProjectionRunner(storage.db, nats.reader, logger);
      await runner.initialise(members);
      await runner.run(members);
      const before = (await storage.db.query("SELECT * FROM members")).rows;
      const broken: EventSource = {
        head: () => Promise.resolve(2),
        async *subscribe() {
          for await (const stored of nats.reader.subscribe(1)) {
            yield stored;
            break;
          }
          throw new Error("injected replay failure");
        },
      };
      await expect(
        rebuildMemberProjection(storage.db, broken, logger),
      ).rejects.toThrow("EVENTS stream is incomplete");
      expect((await storage.db.query("SELECT * FROM members")).rows).toEqual(before);
      expect(
        (
          await storage.db.query<{ table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%_replay'",
          )
        ).rows,
      ).toEqual([]);
      expect(await runner.checkpoint(members)).toBe(1);
    } finally {
      await storage.close();
      await nats.close();
    }
  },
  30_000,
);

it.skipIf(!process.env["PG_TEST_URL"]).each([
  ["missing final event", true],
  ["entirely missing history", false],
])("refuses %s within a bound and releases the advisory lock", async (_name, withFirst) => {
  const nats = await natsFixture();
  const storage = await database("pg");
  const logger = createLogger("rebuild-incomplete", { level: "silent" });
  try {
    if (withFirst) {
      expect((await nats.store.append({ event: event("only"), expectedSequence: 0 })).status).toBe("appended");
    }
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(members);
    const incomplete: EventSource = {
      head: () => nats.reader.head().then((head) => head + 1),
      subscribe: (fromSequence, signal) => nats.reader.subscribe(fromSequence, signal),
    };
    const started = performance.now();
    await expect(rebuildMemberProjection(storage.db, incomplete, logger)).rejects.toThrow("incomplete");
    expect(performance.now() - started).toBeLessThan(3_000);
    if (!storage.db.lock) throw new Error("PostgreSQL lock unavailable");
    await expect(storage.db.lock(members.name, () => Promise.resolve("released"))).resolves.toBe("released");
  } finally {
    await storage.close();
    await nats.close();
  }
}, 15_000);

it.skipIf(!process.env["PG_TEST_URL"])(
  "keeps reader grants and switches after a concurrent identity lookup",
  async () => {
    const controlUrl = process.env["PG_TEST_URL"]!;
    const nats = await natsFixture();
    const storage = await database("pg");
    const suffix = randomUUID().replaceAll("-", "");
    const operator = `replay_operator_${suffix}`;
    const reader = `replay_reader_${suffix}`;
    const databaseName = String((await storage.db.query("SELECT current_database() AS name")).rows[0]?.["name"]);
    const databaseUrl = new URL(controlUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: databaseUrl.href }).on("error", () => undefined);
    const operatorPool = new Pool({ connectionString: databaseUrl.href, max: 1 }).on("error", () => undefined);
    const readerPool = new Pool({ connectionString: databaseUrl.href, max: 1 }).on("error", () => undefined);
    const control = new Pool({ connectionString: controlUrl });
    try {
      expect((await nats.store.append({ event: event("invited", "member-alice", "member.invited"), expectedSequence: 0 })).status).toBe("appended");
      const joined = event("joined");
      expect((await nats.store.append({ event: {
        ...joined,
        principal: { id: "bob", kind: "human" },
        data: { ...joined.data, invitationId: "inv_1" },
      }, expectedSequence: 1 })).status).toBe("appended");
      const initial = new ProjectionRunner(storage.db, nats.reader, createLogger("roles", { level: "silent" }));
      await initial.initialise(members);
      await initial.run(members);
      await admin.query(`CREATE ROLE ${operator}`);
      await admin.query(`CREATE ROLE ${reader}`);
      await admin.query(`GRANT ${operator}, ${reader} TO CURRENT_USER`);
      await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${operator}`);
      for (const table of ["members", "member_identities", "member_changes", "silo_ownership", "inventory_inputs", "projection_checkpoints", "projection_events", "projection_generations"]) {
        await admin.query(`ALTER TABLE ${table} OWNER TO ${operator}`);
      }
      await admin.query(`GRANT SELECT ON members, member_identities, member_changes TO ${reader}`);
      await operatorPool.query(`SET ROLE ${operator}`);
      await readerPool.query(`SET ROLE ${reader}`);
      await readerPool.query("BEGIN");
      await readerPool.query("LOCK TABLE member_identities IN ACCESS SHARE MODE");
      const rebuilding = rebuildMemberProjection(
        pgDb(operatorPool), nats.reader, createLogger("roles-rebuild", { level: "silent" }), { verify: true },
      );
      await delay(100);
      expect((await readerPool.query(`SELECT i.member_id FROM member_identities i
        JOIN members m USING (silo, member_id) WHERE m.status = 'joined'`)).rows).toEqual([{ member_id: "alice" }]);
      await readerPool.query("COMMIT");
      await expect(rebuilding).resolves.toMatchObject({ changed: false, verified: true });
      expect((await readerPool.query("SELECT member_id FROM members")).rows).toEqual([{ member_id: "alice" }]);
      await operatorPool.query("RESET ROLE");
      await admin.query(`REASSIGN OWNED BY ${operator} TO CURRENT_USER`);
      await admin.query(`DROP OWNED BY ${reader}`);
    } finally {
      await readerPool.query("ROLLBACK").catch(() => undefined);
      await Promise.all([admin.end(), operatorPool.end(), readerPool.end()]);
      await storage.close();
      await control.query(`DROP ROLE IF EXISTS ${reader}`);
      await control.query(`DROP ROLE IF EXISTS ${operator}`);
      await control.end();
      await nats.close();
    }
  },
  30_000,
);

it.skipIf(!process.env["PG_TEST_URL"])(
  "verify refuses a different live members state without switching it",
  async () => {
    const nats = await natsFixture();
    const storage = await database("pg");
    const logger = createLogger("rebuild-verify", { level: "silent" });
    try {
      const result = await nats.store.append({ event: event("join"), expectedSequence: 0 });
      expect(result.status).toBe("appended");
      const runner = new ProjectionRunner(storage.db, nats.reader, logger);
      await runner.initialise(members);
      await runner.run(members);
      await storage.db.query("UPDATE members SET display_name = 'Wrong'");
      await expect(
        rebuildMemberProjection(storage.db, nats.reader, logger, { verify: true }),
      ).rejects.toThrow("differs");
      expect((await storage.db.query<{ display_name: string }>("SELECT display_name FROM members")).rows)
        .toEqual([{ display_name: "Wrong" }]);
    } finally {
      await storage.close();
      await nats.close();
    }
  },
  30_000,
);

async function inventoryBackfilled(db: Pick<ReturnType<typeof pgDb>, 'query'>) {
  const table = await db.query<{ name: string | null }>(
    "SELECT to_regclass('inventory_inputs_backfill')::text AS name");
  if (!table.rows[0]?.name) return false;
  const marker = await db.query('SELECT version FROM inventory_inputs_backfill WHERE version = 1');
  return marker.rows.length === 1;
}

async function completesOnlyFullInventoryReplay() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logger = createLogger('inventory-backfill', { level: 'silent' });
  try {
    await nats.seed([event('backfill-one'), event('backfill-two', 'member-bob')]);
    const runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.initialise(members);
    expect(await inventoryBackfilled(storage.db)).toBe(false);
    const incomplete: EventSource = {
      head: nats.reader.head.bind(nats.reader),
      async *subscribe() {
        for await (const stored of nats.reader.subscribe(1)) {
          yield stored;
          break;
        }
      },
    };
    const broken = new ProjectionRunner(storage.db, incomplete, logger);
    await expect(broken.run(members)).rejects.toThrow('incomplete');
    expect(await inventoryBackfilled(storage.db)).toBe(false);
    expect(await runner.checkpoint(members)).toBe(1);
    await runner.run(members);
    expect(await inventoryBackfilled(storage.db)).toBe(false);
    await rebuildMemberProjection(storage.db, nats.reader, logger);
    expect(await inventoryBackfilled(storage.db)).toBe(true);
    await runner.rebuild(members);
    expect(await inventoryBackfilled(storage.db)).toBe(true);
  } finally {
    await storage.close();
    await nats.close();
  }
}
it.skipIf(!process.env['PG_TEST_URL'])(
  'requires a complete inventory rebuild after an interrupted first replay',
  completesOnlyFullInventoryReplay);
