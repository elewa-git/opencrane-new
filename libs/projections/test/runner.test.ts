import { expect, it, vi } from "vitest";
import { Pool } from "pg";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { createLogger } from "@opencrane/observability";
import { parseEventByType } from "@opencrane/events";
import {
  ProjectionRunner,
  members,
  type Projection,
  type EventSource,
} from "../src/index.ts";
import { database } from "./database.ts";

it.each(
  process.env["PG_TEST_URL"]
    ? (["pg", "pglite"] as const)
    : (["pglite"] as const),
)(
  "%s: rollback, restart, members contents and rebuild match durable incremental state",
  async (kind) => {
    const nats = await natsFixture();
    const storage = await database(kind);
    const logs: string[] = [];
    const logger = createLogger("test", {
      level: "info",
      destination: {
        write(line) {
          logs.push(line);
        },
      },
    });
    let crash = true;
    let capturedHead = 0;
    const source: EventSource = {
      head: () => Promise.resolve(capturedHead),
      subscribe(fromSequence, signal) {
        return nats.reader.subscribe(fromSequence, signal);
      },
    };
    async function append(
      fixture: ReturnType<typeof event>,
      expectedSequence: number,
    ) {
      const result = await nats.store.append({
        event: fixture,
        expectedSequence,
      });
      if (result.status !== "appended") {
        throw new Error(`Fixture append failed: ${result.status}`);
      }
      capturedHead = result.sequence;
    }
    const projection: Projection = {
      ...members,
      async create(tx) {
        await members.create(tx);
        await tx.query(
          "CREATE TABLE IF NOT EXISTS counts (event_id TEXT NOT NULL)",
        );
      },
      async drop(tx) {
        await members.drop(tx);
        await tx.query("DROP TABLE counts");
      },
      async apply(tx, envelope, position) {
        await members.apply(tx, envelope, position);
        await tx.query("INSERT INTO counts VALUES ($1)", [envelope.id]);
        if (crash && envelope.id === "join") {
          throw new Error("simulated mid-batch crash");
        }
      },
    };
    try {
      await append(event("invite", "member-alice", "member.invited"), 0);
      await append(event("join"), 1);
      let runner = new ProjectionRunner(storage.db, source, logger);
      await runner.initialise(projection);
      await expect(runner.run(projection)).rejects.toThrow(
        "simulated mid-batch crash",
      );
      expect(await runner.checkpoint(projection)).toBe(1);
      expect((await storage.db.query("SELECT * FROM counts")).rows).toEqual([
        { event_id: "invite" },
      ]);
      expect(
        (await storage.db.query("SELECT status, display_name FROM members"))
          .rows,
      ).toEqual([{ status: "invited", display_name: null }]);
      expect(
        (await storage.db.query("SELECT event_id FROM projection_events")).rows,
      ).toEqual([{ event_id: "invite" }]);
      await storage.reopen();
      crash = false;
      runner = new ProjectionRunner(storage.db, source, logger);
      await runner.run(projection, { attempt: 2 });
      expect(
        (
          await storage.db.query(
            "SELECT status, display_name, email, role FROM members",
          )
        ).rows,
      ).toEqual([
        {
          status: "joined",
          display_name: "Alice",
          email: "alice@example.com",
          role: "member",
        },
      ]);
      await append(event("remove", "member-alice", "member.removed"), 2);
      await append(event("bob", "member-bob", "member.invited"), 0);
      await runner.run(projection);
      const incremental = (
        await storage.db.query("SELECT * FROM members ORDER BY member_id")
      ).rows;
      expect(
        incremental.map((row) => [row["member_id"], row["status"]]),
      ).toEqual([
        ["alice", "removed"],
        ["bob", "invited"],
      ]);
      expect(
        (
          await storage.db.query(
            "SELECT event_id FROM counts ORDER BY event_id",
          )
        ).rows,
      ).toEqual([
        { event_id: "bob" },
        { event_id: "invite" },
        { event_id: "join" },
        { event_id: "remove" },
      ]);
      await runner.run(projection);
      expect(
        (await storage.db.query("SELECT * FROM counts")).rows,
      ).toHaveLength(4);
      const changes = (await storage.db.query("SELECT * FROM member_changes ORDER BY position")).rows;
      const identities = (await storage.db.query("SELECT * FROM member_identities ORDER BY member_id")).rows;
      await runner.rebuild(projection);
      expect((await storage.db.query("SELECT * FROM member_changes ORDER BY position")).rows).toEqual(changes);
      expect((await storage.db.query("SELECT * FROM member_identities ORDER BY member_id")).rows).toEqual(identities);
      expect(
        (await storage.db.query("SELECT * FROM members ORDER BY member_id"))
          .rows,
      ).toEqual(incremental);
      expect(
        (await storage.db.query("SELECT * FROM counts")).rows,
      ).toHaveLength(4);
      expect(await runner.checkpoint(projection)).toBe(4);
      const records: unknown[] = logs.map((line): unknown => JSON.parse(line));
      expect(records).toContainEqual(
        expect.objectContaining({
          handler: "members",
          event_id: "join",
          event_type: "member.joined",
          stream: "member-alice",
          attempt: 1,
          msg: "handler.failed",
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          event_id: "join",
          attempt: 2,
          msg: "handler.completed",
        }),
      );
    } finally {
      try {
        await storage.close();
      } finally {
        await nats.close();
      }
    }
  },
  30_000,
);

it("records event ids independently of checkpoint and refuses an incomplete replay", async () => {
  const storage = await database("pglite");
  const parsed = parseEventByType(event("repeat"));
  if (!parsed.success) {
    throw new Error("Bad fixture");
  }
  const source: EventSource = {
    head: () => Promise.resolve(2),
    // A duplicate delivery with a new position must still apply the handler only once.
    async *subscribe() {
      await Promise.resolve();
      yield { sequence: 1, event: parsed.event };
      yield { sequence: 2, event: parsed.event };
    },
  };
  const projection: Projection = {
    name: "counter",
    async create(tx) {
      await tx.query("CREATE TABLE counter (id TEXT)");
    },
    async drop(tx) {
      await tx.query("DROP TABLE counter");
    },
    async apply(tx, envelope) {
      await tx.query("INSERT INTO counter VALUES ($1)", [envelope.id]);
    },
  };
  try {
    const logger = createLogger("test");
    const runner = new ProjectionRunner(storage.db, source, logger);
    await runner.initialise(projection);
    await runner.run(projection);
    expect((await storage.db.query("SELECT * FROM counter")).rows).toEqual([
      { id: "repeat" },
    ]);
    expect(await runner.checkpoint(projection)).toBe(2);
    const incomplete = new ProjectionRunner(
      storage.db,
      { ...source, head: () => Promise.resolve(3) },
      logger,
    );
    await expect(incomplete.run(projection)).rejects.toThrow(
      "before the captured head",
    );
  } finally {
    await storage.close();
  }
}, 30_000);

it.skipIf(!process.env["PG_TEST_URL"])("drops its PostgreSQL database while a stray connection is open", async () => {
  const controlUrl = process.env["PG_TEST_URL"];
  if (!controlUrl) throw new Error("PG_TEST_URL must allow disposable databases");
  const storage = await database("pg");
  const name = String((await storage.db.query("SELECT current_database() AS name")).rows[0]?.["name"]);
  const childUrl = new URL(controlUrl);
  childUrl.pathname = `/${name}`;
  const stray = new Pool({ connectionString: childUrl.href });
  const admin = new Pool({ connectionString: controlUrl });
  const held = await stray.connect();
  held.on("error", () => undefined);
  await held.query("SELECT 1");
  try {
    await storage.close();
    expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount).toBe(0);
  } finally {
    held.release();
    await stray.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}, 30_000);

it.skipIf(!process.env["PG_TEST_URL"])("drops its database and stays up when pool.end fails with an idle connection", async () => {
  const controlUrl = process.env["PG_TEST_URL"];
  if (!controlUrl) throw new Error("PG_TEST_URL must allow disposable databases");
  const storage = await database("pg");
  const name = String((await storage.db.query("SELECT current_database() AS name")).rows[0]?.["name"]);
  // Fail the first pool.end() so an idle connection is still open when the forced drop ends it.
  const end = vi.spyOn(Pool.prototype, "end").mockRejectedValueOnce(new Error("injected pool.end failure"));
  const admin = new Pool({ connectionString: controlUrl });
  try {
    await expect(storage.close()).rejects.toThrow("injected pool.end failure");
  } finally {
    end.mockRestore();
  }
  try {
    expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount).toBe(0);
  } finally {
    await admin.end();
  }
}, 30_000);
