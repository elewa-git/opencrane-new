import { expect, it } from "vitest";
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
      async apply(tx, envelope) {
        await members.apply(tx, envelope);
        await tx.query("INSERT INTO counts VALUES ($1)", [envelope.id]);
        if (crash && envelope.id === "join") {
          throw new Error("simulated mid-batch crash");
        }
      },
    };
    try {
      await nats.store.append({
        event: event("invite", "member-alice", "member.invited"),
        expectedSequence: 0,
      });
      await nats.store.append({ event: event("join"), expectedSequence: 1 });
      let runner = new ProjectionRunner(storage.db, nats.store, logger);
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
      runner = new ProjectionRunner(storage.db, nats.store, logger);
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
      await nats.store.append({
        event: event("remove", "member-alice", "member.removed"),
        expectedSequence: 2,
      });
      await nats.store.append({
        event: event("bob", "member-bob", "member.invited"),
        expectedSequence: 0,
      });
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
      await runner.rebuild(projection);
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
      await storage.close();
      await nats.close();
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
});
