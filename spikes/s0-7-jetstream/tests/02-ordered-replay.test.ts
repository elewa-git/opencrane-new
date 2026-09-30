// Pass condition 2: ordered replay into a projection, with the consumer's
// checkpoint written in the SAME Postgres transaction as the projection
// row, surviving a simulated crash mid-stream with no double-apply and no
// skip.
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
  processedEventCount,
  type ConversationEvent,
} from "../src/projection.ts";
import type { PGlite } from "@electric-sql/pglite";
import type { NatsConnection } from "@nats-io/nats-core";

let server: RunningNatsServer;
let nc: NatsConnection;
let ctx: Ctx;
let stateDir: string;
const CONSUMER_NAME = "conversation-projection";

// The full set of conversation events we publish, plus interleaved "noise"
// on unrelated subjects that the filtered consumer must NOT see.
const TOTAL_CONVERSATION_EVENTS = 500;
const CRASH_AFTER = 137; // arbitrary "mid-stream" point

interface Published {
  streamSeq: number;
  event: ConversationEvent;
}

beforeAll(async () => {
  stateDir = await freshStateDir("t2-ordered-replay");
  const [port] = await freePorts(1);
  server = await startNatsServer({ name: "t2", port, storeDir: `${stateDir}/node` });
  nc = await connectTo(server.url);
  ctx = await makeCtx(nc);
  await ensureEventsStream(ctx.jsm, { replicas: 1 });
});

afterAll(async () => {
  await nc?.close();
  await server?.stop();
  await removeStateDir(stateDir);
});

async function publishFixture(): Promise<Published[]> {
  const published: Published[] = [];
  const conversationIds = ["conv-a", "conv-b", "conv-c"];
  let seqBySubject = new Map<string, number>();

  for (let i = 0; i < TOTAL_CONVERSATION_EVENTS; i++) {
    const conversationId = conversationIds[i % conversationIds.length];
    const subject = `ev.conversation.${conversationId}`;
    const expected = seqBySubject.get(subject) ?? 0;
    const event: ConversationEvent = {
      eventId: `evt-${i}`,
      conversationId,
      text: `message #${i} for ${conversationId}`,
    };
    const res = await conditionalAppend(ctx.js, subject, encode(event), {
      expectedLastSubjectSequence: expected,
      msgId: event.eventId,
    });
    if (!res.ok || !res.ack) throw new Error(`fixture publish ${i} failed: ${res.errMessage}`);
    seqBySubject.set(subject, res.ack.seq);
    published.push({ streamSeq: res.ack.seq, event });

    // Noise on a subject the projection's consumer does NOT filter for —
    // proves subject-prefix filtering actually works, not just "it saw
    // everything and happened to be right".
    if (i % 5 === 0) {
      await conditionalAppend(ctx.js, "ev.budget.acme", encode({ noise: i }), {
        expectedLastSubjectSequence: 0,
        msgId: `noise-${i}`,
      }).catch(() => {}); // budget subject sequence isn't tracked here; ignore races
    }
  }
  return published;
}

/** Expected final projection, computed independently in plain JS, to check
 * the PGlite-built projection against. */
function expectedProjection(published: Published[]) {
  const byConv = new Map<string, { count: number; last: string }>();
  for (const p of published) {
    const cur = byConv.get(p.event.conversationId) ?? { count: 0, last: "" };
    cur.count += 1;
    cur.last = p.event.text;
    byConv.set(p.event.conversationId, cur);
  }
  return [...byConv.entries()]
    .map(([conversation_id, v]) => ({ conversation_id, message_count: v.count, last_message: v.last }))
    .sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
}

/** Runs the ordered-consumer-into-PGlite projection loop, starting from
 * whatever checkpoint is already in `db`, and stopping after `stopAfter`
 * events have been applied in THIS run. Simulates an abrupt crash when
 * `stopAfter` is below the number of messages actually available: the loop
 * is torn down without an orderly drain, so any message already pulled off
 * the wire but not yet committed is dropped, exactly as a killed process
 * would drop it. `available` bounds how many matching messages exist right
 * now, so a full drain knows when to stop asking instead of idling out on
 * the consumer's pull `expires` timeout. */
async function runProjectionOnce(db: PGlite, available: number, stopAfter: number): Promise<number> {
  const startSeq = (await getCheckpoint(db, CONSUMER_NAME)) + 1;
  const consumer = await ctx.js.consumers.get("EVENTS", {
    filter_subjects: ["ev.conversation.>"],
    deliver_policy: startSeq > 1 ? DeliverPolicy.StartSequence : DeliverPolicy.All,
    opt_start_seq: startSeq > 1 ? startSeq : undefined,
  });
  const iter = await consumer.consume({ max_messages: available, expires: 2000 });
  let appliedThisRun = 0;
  const target = Math.min(available, stopAfter);
  for await (const m of iter) {
    const event = decode<ConversationEvent>(m.data);
    await applyEventTransactionally(db, CONSUMER_NAME, m.seq, event);
    m.ack();
    appliedThisRun++;
    if (appliedThisRun >= target) {
      // Stop pulling. When target === available this is an orderly drain;
      // when target < available (the crash case) it abandons whatever the
      // consumer still had buffered, same as a process kill would.
      break;
    }
  }
  await iter.stop();
  return appliedThisRun;
}

describe("S0.7 pass condition 2: ordered replay into a projection, crash-safe", () => {
  it("resumes from the transactional checkpoint after a simulated crash with no double-apply and no skip", async () => {
    const published = await publishFixture();
    const expected = expectedProjection(published);

    const dbDir = `${stateDir}/pglite-projection`;
    let db = await openProjectionDb(dbDir);

    // First "process life": crash after CRASH_AFTER events.
    const firstRunApplied = await runProjectionOnce(db, TOTAL_CONVERSATION_EVENTS, CRASH_AFTER);
    expect(firstRunApplied).toBe(CRASH_AFTER);
    const checkpointAfterCrash = await getCheckpoint(db, CONSUMER_NAME);
    expect(checkpointAfterCrash).toBeGreaterThan(0);

    // Simulate the process actually dying: close this PGlite handle and
    // open a brand new one against the same on-disk directory, exactly as
    // a restarted server process would.
    await db.close();
    db = await openProjectionDb(dbDir);
    const resumedCheckpoint = await getCheckpoint(db, CONSUMER_NAME);
    expect(resumedCheckpoint).toBe(checkpointAfterCrash);

    // Second "process life": resume from the checkpoint and drain the rest.
    const remaining = TOTAL_CONVERSATION_EVENTS - firstRunApplied;
    const secondRunApplied = await runProjectionOnce(db, remaining, remaining);
    console.log(
      `[t2] crash after ${CRASH_AFTER} events (checkpoint=${checkpointAfterCrash}); resumed run applied ${secondRunApplied} more`,
    );

    const finalCheckpoint = await getCheckpoint(db, CONSUMER_NAME);
    const totalApplied = await processedEventCount(db);

    // No skip: every published conversation event was eventually applied.
    expect(totalApplied).toBe(TOTAL_CONVERSATION_EVENTS);
    // No double-apply: processed_events has a PRIMARY KEY on event_id, so a
    // re-application would have thrown inside the transaction; reaching
    // here with totalApplied === TOTAL_CONVERSATION_EVENTS already proves
    // no duplicate insert happened (it would have made this test throw).
    expect(finalCheckpoint).toBe(published[published.length - 1].streamSeq);

    const actual = await dumpProjection(db);
    expect(actual).toEqual(expected);

    await db.close();
  });
});
