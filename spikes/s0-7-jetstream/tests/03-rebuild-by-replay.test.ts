// Pass condition 3: rebuild by replay. Build the projection incrementally
// as events arrive, hash it; drop the projection tables; replay the whole
// stream from the start into the same tables; hash again; the two hashes
// must match exactly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliverPolicy } from "@nats-io/jetstream";
import { freePorts } from "../src/ports.ts";
import { freshStateDir, removeStateDir, startNatsServer, connectTo, type RunningNatsServer } from "../src/nats-proc.ts";
import { conditionalAppend, encode, decode, ensureEventsStream, makeCtx, type Ctx } from "../src/jetstream.ts";
import {
  openProjectionDb,
  applyEventTransactionally,
  dumpProjection,
  dropProjectionTables,
  processedEventCount,
  type ConversationEvent,
} from "../src/projection.ts";
import { hashOf } from "../src/hash.ts";
import type { NatsConnection } from "@nats-io/nats-core";

let server: RunningNatsServer;
let nc: NatsConnection;
let ctx: Ctx;
let stateDir: string;
const CONSUMER_NAME = "conversation-projection";
const EVENT_COUNT = 300;

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

async function drainInto(db: Awaited<ReturnType<typeof openProjectionDb>>, startSeq: number, count: number) {
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
  it("produces an identical projection after drop + full replay as the incrementally built one", async () => {
    const conversationIds = ["conv-x", "conv-y", "conv-z", "conv-w"];
    let seqBySubject = new Map<string, number>();
    for (let i = 0; i < EVENT_COUNT; i++) {
      const conversationId = conversationIds[i % conversationIds.length];
      const subject = `ev.conversation.${conversationId}`;
      const expected = seqBySubject.get(subject) ?? 0;
      const event: ConversationEvent = {
        eventId: `rbr-evt-${i}`,
        conversationId,
        text: `payload ${i}`,
      };
      const res = await conditionalAppend(ctx.js, subject, encode(event), {
        expectedLastSubjectSequence: expected,
        msgId: event.eventId,
      });
      if (!res.ok || !res.ack) throw new Error(`fixture publish failed: ${res.errMessage}`);
      seqBySubject.set(subject, res.ack.seq);
    }

    const dbDir = `${stateDir}/pglite-projection`;
    const db = await openProjectionDb(dbDir);

    // Build incrementally.
    const incrementalApplied = await drainInto(db, 1, EVENT_COUNT);
    expect(incrementalApplied).toBe(EVENT_COUNT);
    const incrementalRows = await dumpProjection(db);
    const incrementalCount = await processedEventCount(db);
    const incrementalHash = hashOf(incrementalRows);

    // Drop and rebuild from scratch by replaying the whole stream again.
    await dropProjectionTables(db);
    expect(await dumpProjection(db)).toEqual([]);

    const rebuiltApplied = await drainInto(db, 1, EVENT_COUNT);
    expect(rebuiltApplied).toBe(EVENT_COUNT);
    const rebuiltRows = await dumpProjection(db);
    const rebuiltCount = await processedEventCount(db);
    const rebuiltHash = hashOf(rebuiltRows);

    console.log(
      `[t3] incremental hash=${incrementalHash.slice(0, 12)} rebuilt hash=${rebuiltHash.slice(0, 12)} rows=${rebuiltRows.length}`,
    );

    expect(rebuiltCount).toBe(incrementalCount);
    expect(rebuiltHash).toBe(incrementalHash);
    expect(rebuiltRows).toEqual(incrementalRows);

    await db.close();
  });
});
