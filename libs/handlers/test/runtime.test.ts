import { afterEach, describe, expect, it } from "vitest";
import { event } from "@opencrane/event-store/testing";
import { jetstreamManager } from "@nats-io/jetstream";
import { createEventStore } from "@opencrane/event-store";
import { members, ProjectionRunner, type EventSource } from "@opencrane/projections";
import { createLogger } from "@opencrane/observability";
import { HandlerRuntime, registerHandler, dispatch } from "../src/index.ts";
import { effect, fixture, until, deferred } from "./helpers.ts";

describe.skipIf(!process.env["PG_TEST_URL"])(
  "handler runtime / real PostgreSQL 17 and NATS",
  () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    afterEach(async () => {
      if (f) {
        await f.close();
      }
    });

    it("fresh production provisioning supports append, projection and durable dispatch", async () => {
      f = await fixture(); // Runs the production provision command against an empty server.
      expect(await f.nats.store.head()).toBe(0);
      await f.append("fresh");
      const runner = new ProjectionRunner(f.db, f.nats.reader, createLogger("test"));
      await runner.initialise(members);
      await runner.run(members);
      expect(await runner.checkpoint(members)).toBe(1);
      expect((await f.db.query("SELECT status FROM members")).rows).toEqual([{ status: "joined" }]);
      const runtime = await f.runtime([registerHandler("update-members", effect)]);
      void f.startDispatch(runtime);
      await f.checkpoint(1);
      await runtime.work();
      await until(async () => (await f.effects()).length === 1);
      expect((await f.effects()).map((row) => row.event_id)).toEqual(["fresh"]);
    }, 30_000);

    it("projection SIGKILL after delivery before SQL commit resumes from its durable checkpoint", async () => {
      f = await fixture();
      await f.append("first");
      await f.append("second", "member-bob");
      await f.crash("projection-before-commit");
      expect((await f.db.query("SELECT sequence FROM projection_checkpoints")).rows).toEqual([{ sequence: "0" }]);
      expect((await f.db.query("SELECT * FROM members")).rows).toEqual([]);
      const reader = await createEventStore(await f.nats.client("projection"));
      const runner = new ProjectionRunner(f.db, reader, createLogger("test"));
      await runner.run(members, { signal: AbortSignal.timeout(5000) });
      expect(await runner.checkpoint(members)).toBe(2);
      expect((await f.db.query("SELECT event_id FROM projection_events ORDER BY event_id")).rows)
        .toEqual([{ event_id: "first" }, { event_id: "second" }]);
      expect((await f.db.query("SELECT member_id FROM members ORDER BY member_id")).rows)
        .toEqual([{ member_id: "alice" }, { member_id: "bob" }]);
    }, 30_000);

    it("bounded projection drain discards prefetched events and resumes at the SQL checkpoint", async () => {
      f = await fixture();
      await f.append("first");
      const prefetched: number[] = [];
      const source: EventSource = {
        head: () => f.nats.reader.head(),
        async *subscribe(fromSequence, signal) {
          const reader = f.nats.reader.subscribe(fromSequence, signal);
          try {
            const first = await reader.next();
            // The runner captured head 1. Force delivery of event 2 into a local
            // buffer before it commits event 1, then discard that buffer on return.
            await f.append("second", "member-bob");
            const ahead = await reader.next();
            if (ahead.done || first.done) throw new Error("Missing test events");
            prefetched.push(ahead.value.sequence);
            yield first.value;
            yield ahead.value;
          } finally {
            await reader.return(undefined);
          }
        },
      };
      const logger = createLogger("test");
      let runner = new ProjectionRunner(f.db, source, logger);
      await runner.initialise(members);
      await runner.run(members, { signal: AbortSignal.timeout(5000) });
      expect(prefetched).toEqual([2]);
      expect(await runner.checkpoint(members)).toBe(1);
      expect((await f.db.query("SELECT event_id FROM projection_events")).rows).toEqual([{ event_id: "first" }]);
      await f.append("third", "member-carol");
      const reader = await createEventStore(await f.nats.client("projection"));
      runner = new ProjectionRunner(f.db, reader, logger);
      await runner.run(members, { signal: AbortSignal.timeout(5000) });
      expect(await runner.checkpoint(members)).toBe(3);
      expect((await f.db.query("SELECT event_id FROM projection_events ORDER BY event_id")).rows)
        .toEqual([{ event_id: "first" }, { event_id: "second" }, { event_id: "third" }]);
    }, 30_000);

    it("fans out catalogue subscriptions and keeps each stream serial while other streams run in parallel", async () => {
      f = await fixture();
      let release!: () => void;
      const otherStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const active = new Set<string>();
      let maximum = 0;
      const runtime = await f.runtime([
        registerHandler("update-members", async (event, tx) => {
          expect(active.has(event.subject)).toBe(false);
          active.add(event.subject);
          maximum = Math.max(maximum, active.size);
          if (event.id === "a0") {
            await otherStarted;
          }
          if (event.id === "b0") {
            release();
          }
          await effect(event, tx);
          active.delete(event.subject);
        }),
        registerHandler("update-openfga", (event, tx) =>
          effect(event, tx, "update-openfga"),
        ),
      ]);
      for (let i = 0; i < 4; i++) {
        await f.append(`a${i}`, "member-alice");
        await f.append(`b${i}`, "member-bob");
      }
      await f.append("invited", "member-carol", "member.invited");
      void f.startDispatch(runtime);
      await f.checkpoint(9);
      await runtime.work(4);
      await until(async () => (await f.effects()).length === 17);
      for (const handler of ["update-members", "update-openfga"]) {
        for (const [prefix, stream] of [
          ["a", "member-alice"],
          ["b", "member-bob"],
        ]) {
          expect(
            (await f.effects())
              .filter((row) => row.handler === handler && row.stream === stream)
              .map((row) => row.event_id),
          ).toEqual([0, 1, 2, 3].map((i) => `${prefix}${i}`));
        }
      }
      expect(maximum).toBeGreaterThan(1);
      expect(
        (await f.effects())
          .filter((row) => row.event_id === "invited")
          .map((row) => row.handler),
      ).toEqual(["update-members"]);
    }, 30_000);

    it("rolls back a failed effect, retries with backoff, and records attempt fields", async () => {
      f = await fixture();
      const logs: string[] = [];
      const logger = createLogger("attempt-test", {
        level: "info",
        destination: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      });
      const attempts: number[] = [];
      const handler = registerHandler("update-members", async (event, tx) => {
        attempts.push(Date.now());
        await effect(event, tx);
        if (attempts.length === 1) {
          throw new Error("temporary failure");
        }
      });
      const runtime = await f.runtime([handler]);
      runtime.options.logger = logger;
      await f.append("retry");
      void f.startDispatch(runtime);
      await runtime.work();
      await until(async () => (await f.effects()).length === 1);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(1000);
      expect(logs.join("")).toContain('"attempt":2');
      expect(logs.join("")).toContain('"event_id":"retry"');
      expect(logs.join("")).toContain('"stream":"member-alice"');
      expect(logs.join("")).toContain('"handler":"update-members"');
      expect(logs.join("")).toContain("handler.failed");
    }, 30_000);

    it("keeps a dead-letter head in place through maintenance and replays before its successors", async () => {
      f = await fixture();
      let failing = true;
      const runtime = await f.runtime([
        registerHandler("update-members", async (event, tx) => {
          await effect(event, tx);
          if (event.id === "poison" && failing) {
            throw new Error("poison");
          }
        }),
      ]);
      await f.append("poison");
      await f.append("successor");
      await f.append("other", "member-bob");
      void f.startDispatch(runtime);
      await runtime.work();
      await until(
        async () => (await runtime.deadLetters("update-members")).length === 1,
      );
      await until(async () => (await f.effects()).length === 1);
      expect((await f.effects()).map((row) => row.event_id)).toEqual(["other"]);
      const dead = (await runtime.deadLetters("update-members"))[0]!;
      expect(dead.retryCount).toBe(1);
      expect(await runtime.boss.findJobs("update-members-dead")).toHaveLength(
        1,
      );
      const retention = await f.db.query<{
        keep: string;
        deletion_seconds: number;
      }>(
        "SELECT keep_until::text AS keep, deletion_seconds FROM pgboss.job WHERE name = 'update-members'",
      );
      expect(
        retention.rows.every(
          (row) => row.keep === "infinity" && row.deletion_seconds === 0,
        ),
      ).toBe(true);
      await f.db.query(
        "UPDATE pgboss.job SET completed_on = now() - interval '100 days' WHERE state = 'failed'",
      );
      await runtime.boss.supervise();
      expect(await runtime.boss.getBlockedKeys("update-members")).toEqual([
        "member-alice",
      ]);
      expect((await f.effects()).map((row) => row.event_id)).toEqual(["other"]);
      failing = false;
      await runtime.replay("update-members", dead.id);
      await until(async () => (await f.effects()).length === 3);
      expect((await f.effects()).map((row) => row.event_id)).toEqual([
        "other",
        "poison",
        "successor",
      ]);
      await expect(runtime.replay("update-members", dead.id)).rejects.toThrow(
        "not found",
      );
    }, 30_000);

    it("applies members through the supplied transaction and deduplicates a new job after the old job is deleted", async () => {
      f = await fixture();
      await members.create(f.db);
      const runtime = await f.runtime([
        registerHandler("update-members", async (event, tx) => {
          await members.apply(tx, event, 1);
          await effect(event, tx);
        }),
      ]);
      await f.append("joined");
      void f.startDispatch(runtime);
      await runtime.work();
      await until(async () =>
        (await runtime.boss.findJobs("update-members")).some(
          (job) => job.state === "completed",
        ),
      );
      const jobs = await runtime.boss.findJobs("update-members");
      await runtime.boss.deleteJob("update-members", jobs[0]!.id);
      await runtime.boss.send("update-members", event("joined"), {
        singletonKey: "member-alice",
      });
      await until(async () =>
        (await runtime.boss.findJobs("update-members")).some(
          (job) => job.state === "completed",
        ),
      );
      expect((await f.effects()).map((row) => row.event_id)).toEqual([
        "joined",
      ]);
      expect((await f.db.query("SELECT status FROM members")).rows).toEqual([
        { status: "joined" },
      ]);
    }, 30_000);

    it.each(["before-commit", "after-commit", "after-ack"])(
      "recovers dispatcher SIGKILL %s without losing fan-out or duplicating effects",
      async (boundary) => {
        f = await fixture();
        await f.append("first");
        await f.append("second");
        await f.crash(`dispatcher-${boundary}`);
        const rows = await f.db.query<{ sequence: string }>(
          "SELECT sequence FROM handler_dispatcher",
        );
        expect(Number(rows.rows[0]?.sequence)).toBe(
          boundary === "before-commit" ? 0 : 1,
        );
        const manager = await jetstreamManager(f.nats.connection);
        const info = await manager.consumers.info("EVENTS", "handler-dispatcher");
        expect(info.ack_floor.stream_seq).toBe(boundary === "after-ack" ? 1 : 0);
        expect(info.delivered.stream_seq).toBe(boundary === "after-ack" ? 2 : 1);
        const runtime = await f.runtime(
          [
            registerHandler("update-members", effect),
            registerHandler("update-openfga", (event, tx) =>
              effect(event, tx, "update-openfga"),
            ),
          ],
          { expireInSeconds: 1 },
        );
        expect(await runtime.boss.findJobs("update-members")).toHaveLength(
          boundary === "before-commit" ? 0 : 1,
        );
        expect(await runtime.boss.findJobs("update-openfga")).toHaveLength(
          boundary === "before-commit" ? 0 : 1,
        );
        void f.startDispatch(runtime);
        await runtime.work();
        await f.checkpoint(2);
        await until(async () => (await f.effects()).length === 4);
        for (const handler of ["update-members", "update-openfga"]) {
          expect(
            (await f.effects())
              .filter((row) => row.handler === handler)
              .map((row) => row.event_id),
          ).toEqual(["first", "second"]);
          expect(await runtime.boss.findJobs(handler)).toHaveLength(2);
        }
      },
      30_000,
    );

    it.each(["before-commit", "after-commit"])(
      "recovers worker SIGKILL %s with no repeated committed SQL effects",
      async (boundary) => {
        f = await fixture();
        const runtime = await f.runtime(
          [registerHandler("update-members", effect)],
          { expireInSeconds: 1 },
        );
        await f.append("first");
        await f.append("second");
        void f.startDispatch(runtime);
        await f.checkpoint(2);
        await f.crash(`worker-${boundary}`);
        expect((await f.effects()).length).toBe(
          boundary === "after-commit" ? 1 : 0,
        );
        await until(async () => {
          const rows = await f.db.query(
            "SELECT id FROM pgboss.job WHERE state = 'active' AND started_on < now() - interval '1 second'",
          );
          return rows.rows.length === 1;
        });
        await runtime.boss.supervise();
        await runtime.work();
        await until(async () => (await f.effects()).length === 2);
        expect((await f.effects()).map((row) => row.event_id)).toEqual([
          "first",
          "second",
        ]);
        expect(
          (await runtime.boss.findJobs("update-members")).some(
            (job) => job.retryCount === 1,
          ),
        ).toBe(true);
      },
      30_000,
    );

    it.each(["SQL", "unsettled promise", "concurrent SQL"])(
      "rolls back a timed-out %s handler, recovers another expired stream and fences late writes",
      async (mode) => {
        f = await fixture();
        const release = deferred<void>();
        const lateWrite = deferred<unknown>();
        const runtime = await f.runtime(
          [
            registerHandler("update-members", async (event, tx) => {
              await effect(event, tx);
              if (event.id === "slow") {
                try {
                  if (mode === "SQL") {
                    await tx.query("SELECT pg_sleep(7)");
                  } else if (mode === "concurrent SQL") {
                    await Promise.all(
                      Array.from({ length: 6 }, () =>
                        tx.query("SELECT pg_sleep(0.7)"),
                      ),
                    );
                  } else {
                    await release.promise;
                  }
                } finally {
                  await release.promise;
                  try {
                    await effect(event, tx);
                    lateWrite.resolve("unexpected write");
                  } catch (error) {
                    lateWrite.resolve(error);
                  }
                }
              }
            }),
          ],
          { expireInSeconds: 1, retryLimit: 0 },
        );
        await f.append("abandoned", "member-bob");
        void f.startDispatch(runtime);
        await f.checkpoint(1);
        // Claim a different stream as though its worker died after fetching.
        expect(await runtime.boss.fetch("update-members")).toHaveLength(1);
        await f.append("slow");
        await f.append("free", "member-carol");
        await f.checkpoint(3);
        await runtime.work();
        await until(
          async () =>
            (
              await f.db.query(
                "SELECT id FROM pgboss.job WHERE singleton_key = 'member-bob' AND started_on < now() - interval '1 second'",
              )
            ).rows.length === 1,
        );
        // This used to wait on slow's lock and prevent unrelated claim recovery.
        const recoveryStarted = performance.now();
        await runtime.boss.supervise();
        await until(
          async () =>
            (await runtime.deadLetters("update-members")).length === 2,
          3000,
        );
        expect(performance.now() - recoveryStarted).toBeLessThan(1500);
        expect((await f.effects()).map((row) => row.event_id)).toEqual([
          "free",
        ]);
        release.resolve();
        expect(await lateWrite.promise).toMatchObject({
          message: "Handler transaction is closed",
        });
        expect((await f.effects()).map((row) => row.event_id)).toEqual([
          "free",
        ]);
      },
      15_000,
    );

    it("does not complete an event whose handler swallowed a SQL failure", async () => {
      f = await fixture();
      const runtime = await f.runtime(
        [
          registerHandler("update-members", async (event, tx) => {
            await effect(event, tx);
            await tx.query("SELECT 1 / 0").catch(() => undefined);
          }),
        ],
        { retryLimit: 0 },
      );
      await f.append("failed-sql");
      await f.append("successor");
      void f.startDispatch(runtime);
      await runtime.work();
      await until(
        async () => (await runtime.deadLetters("update-members")).length === 1,
      );
      expect(await f.effects()).toEqual([]);
      expect(await runtime.boss.getBlockedKeys("update-members")).toEqual([
        "member-alice",
      ]);
    }, 15_000);

    it("refuses a foreign silo event without acknowledging or enqueuing it", async () => {
      f = await fixture();
      const runtime = await f.runtime([
        registerHandler("update-members", effect),
      ]);
      expect(
        (
          await f.nats.store.append({
            event: { ...event("foreign"), silo: "another-silo" },
            expectedSequence: 0,
          })
        ).status,
      ).toBe("appended");
      await expect(
        dispatch(f.nats.dispatcherConnection, runtime, new AbortController().signal),
      ).rejects.toThrow("silo mismatch");
      expect(await runtime.boss.findJobs("update-members")).toHaveLength(0);
      const rows = await f.db.query<{ sequence: string }>(
        "SELECT sequence FROM handler_dispatcher",
      );
      expect(rows.rows[0]?.sequence).toBe("0");
    }, 30_000);

    it("rejects subscription drift and incompatible existing FIFO queues", async () => {
      f = await fixture();
      const handler = registerHandler("update-members", effect);
      expect(
        () =>
          new HandlerRuntime({
            db: f.db,
            logger: createLogger("test"),
            silo: "test",
            handlers: [{ ...handler, eventTypes: [] }],
          }),
      ).toThrow("catalogue");
      const runtime = await f.runtime([handler]);
      await runtime.boss.updateQueue("update-members", {
        deleteAfterSeconds: 1,
      });
      await expect(runtime.start()).rejects.toThrow(
        "Incompatible handler queue",
      );
    }, 30_000);
  },
);
