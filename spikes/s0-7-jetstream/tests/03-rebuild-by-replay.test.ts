// Pass condition 3: rebuild by replay. Build the projection the way it
// would genuinely happen in production — in CHUNKS, interleaved with more
// events still being published, closing and reopening PGlite between
// chunks (like a projection worker restarting) — hash it; drop the
// projection tables; replay the WHOLE stream from the start in one full
// drain; hash again; the two hashes must match exactly.
//
// Building the "incremental" side as one single full drain after all
// publishing is done (as an earlier version of this test did) is close to
// tautological: that is the same operation as the rebuild, just run once
// more. Chunking the incremental build, restarting PGlite between chunks,
// and publishing more events between chunks makes it a genuinely different
// code path from "replay everything from sequence 1 in one go".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliverPolicy } from "@nats-io/jetstream";
import { freePorts } from "../src/ports.ts";
import { freshStateDir, removeStateDir, startNatsServer, connectTo, type RunningNatsServer } from "../src/nats-proc.ts";
import { conditionalAppend, encode, decode, ensureEventsStream, makeCtx, type Ctx } from "../src/jetstream.ts";
import {
  openProjectionDb,
  applyEventTransactionally,
  getCheckpoint,
  dumpProjection,
  dropProjectionTables,
  processedEventCount,
  type ConversationEvent,
} from "../src/projection.ts";
import { hashOf } from "../src/hash.ts";
import type { PGlite } from "@electric-sql/pglite";
import type { NatsConnection } from "@nats-io/nats-core";

let server: RunningNatsServer;
let nc: NatsConnection;
let ctx: Ctx;
let stateDir: string;
const CONSUMER_NAME = "conversation-projection";
// Sums to 300 — five uneven chunks, so no two chunks are treated alike.
const CHUNK_SIZES = [37, 61, 53, 79, 70];
const EVENT_COUNT = CHUNK_SIZES.reduce((a, b) => a + b, 0);

beforeAll(async () => {
  stateDir = await freshStateDir("t3-rebuild-by-replay");
  const [port] = await freePorts(1);
  server = await startNatsServer({ name: "t3", port, storeDir: `${stateDir}/node` });
  nc = await connectTo(server.url);
  ctx = await makeCtx(nc);
  await ensureEventsStream(ctx.jsm, { replicas: 1 });
});

afterAll(async () => {
  await nc?.close();
  await server?.stop();
  await removeStateDir(stateDir);
});

/** Drains whatever is newly available (from the DB's own stored checkpoint
 * onward) into `db`, up to `count` messages. Re-reads the checkpoint from
 * `db` itself every time, so it works the same whether `db` is the
 * original handle or a freshly reopened one after a simulated restart. */
async function drainInto(db: PGlite, count: number): Promise<number> {
  const startSeq = (await getCheckpoint(db, CONSUMER_NAME)) + 1;
  const consumer = await ctx.js.consumers.get("EVENTS", {
    filter_subjects: ["ev.conversation.>"],
    deliver_policy: startSeq > 1 ? DeliverPolicy.StartSequence : DeliverPolicy.All,
    opt_start_seq: startSeq > 1 ? startSeq : undefined,
  });
  const iter = await consumer.consume({ max_messages: count, expires: 2000 });
  let n = 0;
  for await (const m of iter) {
    const event = decode<ConversationEvent>(m.data);
    await applyEventTransactionally(db, CONSUMER_NAME, m.seq, event);
    m.ack();
    n++;
    if (n >= count) break;
  }
  await iter.stop();
  return n;
}

describe("S0.7 pass condition 3: rebuild by replay", () => {
  it("produces an identical projection after drop + full replay as a CHUNKED, interleaved incremental build", async () => {
    const conversationIds = ["conv-x", "conv-y", "conv-z", "conv-w"];
    const seqBySubject = new Map<string, number>();
    let nextEventIndex = 0;

    async function publishChunk(n: number): Promise<void> {
      for (let k = 0; k < n; k++) {
        const i = nextEventIndex++;
        const conversationId = conversationIds[i % conversationIds.length];
        const subject = `ev.conversation.${conversationId}`;
        const expected = seqBySubject.get(subject) ?? 0;
        const event: ConversationEvent = { eventId: `rbr-evt-${i}`, conversationId, text: `payload ${i}` };
        const res = await conditionalAppend(ctx.js, subject, encode(event), {
          expectedLastSubjectSequence: expected,
          msgId: event.eventId,
        });
        if (!res.ok || !res.ack) throw new Error(`fixture publish failed: ${res.errMessage}`);
        seqBySubject.set(subject, res.ack.seq);
      }
    }

    const dbDir = `${stateDir}/pglite-projection`;
    let db = await openProjectionDb(dbDir);
    let incrementalApplied = 0;

    // Build the "incremental" side in uneven chunks, publishing more events
    // between chunks (the projection is genuinely catching up on new
    // events, not just replaying a fixed, already-complete stream) and
    // closing + reopening PGlite between chunks (a real restart, exactly
    // like the crash-safety test) to prove the checkpoint-resume path, not
    // one continuous drain, produced this projection.
    for (const size of CHUNK_SIZES) {
      await publishChunk(size);
      await db.close();
      db = await openProjectionDb(dbDir);
      const applied = await drainInto(db, size);
      expect(applied).toBe(size);
      incrementalApplied += applied;
    }
    expect(incrementalApplied).toBe(EVENT_COUNT);

    const incrementalRows = await dumpProjection(db);
    const incrementalCount = await processedEventCount(db);
    const incrementalHash = hashOf(incrementalRows);

    // Drop and rebuild from scratch by replaying the WHOLE stream again, in
    // one full drain from sequence 1 — the actual "full rebuild" operation
    // pass condition 3 is about.
    await dropProjectionTables(db);
    expect(await dumpProjection(db)).toEqual([]);
    expect(await getCheckpoint(db, CONSUMER_NAME)).toBe(0);

    const rebuiltApplied = await drainInto(db, EVENT_COUNT);
    expect(rebuiltApplied).toBe(EVENT_COUNT);
    const rebuiltRows = await dumpProjection(db);
    const rebuiltCount = await processedEventCount(db);
    const rebuiltHash = hashOf(rebuiltRows);

    console.log(
      `[t3] incremental (chunked ${CHUNK_SIZES.join("+")}=${EVENT_COUNT}, ${CHUNK_SIZES.length} restarts) hash=${incrementalHash.slice(0, 12)} ` +
        `rebuilt (single full replay) hash=${rebuiltHash.slice(0, 12)} rows=${rebuiltRows.length}`,
    );

    expect(rebuiltCount).toBe(incrementalCount);
    expect(rebuiltHash).toBe(incrementalHash);
    expect(rebuiltRows).toEqual(incrementalRows);

    await db.close();
  });
});
