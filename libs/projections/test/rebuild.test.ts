import { expect, it } from "vitest";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { createLogger } from "@opencrane/observability";
import {
  members,
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
      const runner = new ProjectionRunner(storage.db, nats.store, logger);
      await runner.initialise(members);
      await runner.run(members);
      const before = (await storage.db.query("SELECT * FROM members")).rows;
      const broken: EventSource = {
        head: () => Promise.resolve(2),
        async *subscribe() {
          for await (const stored of nats.store.subscribe(1)) {
            yield stored;
            break;
          }
          throw new Error("injected replay failure");
        },
      };
      await expect(
        rebuildMemberProjection(storage.db, broken, logger),
      ).rejects.toThrow("injected replay failure");
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

it.skipIf(!process.env["PG_TEST_URL"])(
  "verify refuses a different live members state without switching it",
  async () => {
    const nats = await natsFixture();
    const storage = await database("pg");
    const logger = createLogger("rebuild-verify", { level: "silent" });
    try {
      const result = await nats.store.append({ event: event("join"), expectedSequence: 0 });
      expect(result.status).toBe("appended");
      const runner = new ProjectionRunner(storage.db, nats.store, logger);
      await runner.initialise(members);
      await runner.run(members);
      await storage.db.query("UPDATE members SET display_name = 'Wrong'");
      await expect(
        rebuildMemberProjection(storage.db, nats.store, logger, { verify: true }),
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
