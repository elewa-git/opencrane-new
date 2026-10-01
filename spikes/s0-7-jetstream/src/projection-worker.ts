// Standalone worker process for pass condition 2's REAL crash test.
//
// This file is never imported by the test — it is spawned as its own OS
// process (`node --experimental-strip-types projection-worker.ts`) so the
// test can send it a real SIGKILL. A killed process gets no chance to run
// cleanup code, close its consumer nicely, or finish a transaction, which
// is exactly the failure this pass condition has to survive: PGlite (a
// real Postgres engine) must come back up from its on-disk files with
// whatever was actually committed, no more and no less.
//
// Configured entirely through environment variables so the parent test can
// spawn many short-lived copies of it:
//   WORKER_NATS_URL        host:port of the nats-server to connect to
//   WORKER_PGLITE_DIR      on-disk directory for the PGlite projection
//   WORKER_FILTER_SUBJECT  subject filter for the ordered consumer
//   WORKER_CONSUMER_NAME   checkpoint row name (shared across restarts)
//   WORKER_TARGET_SEQ      optional: once the checkpoint reaches this
//                          stream sequence, print DONE and exit(0) cleanly
//                          instead of running forever (used for the final,
//                          un-killed "let it finish" run)
import { DeliverPolicy } from "@nats-io/jetstream";
import { connectTo } from "./nats-proc.ts";
import { makeCtx, decode } from "./jetstream.ts";
import { openProjectionDb, applyEventTransactionally, getCheckpoint, type ConversationEvent } from "./projection.ts";

const natsUrl = process.env.WORKER_NATS_URL;
const pgliteDir = process.env.WORKER_PGLITE_DIR;
const filterSubject = process.env.WORKER_FILTER_SUBJECT ?? "ev.conversation.>";
const consumerName = process.env.WORKER_CONSUMER_NAME ?? "conversation-projection";
const targetSeq = process.env.WORKER_TARGET_SEQ ? Number(process.env.WORKER_TARGET_SEQ) : undefined;

if (!natsUrl || !pgliteDir) {
  console.error("WORKER ERROR: WORKER_NATS_URL and WORKER_PGLITE_DIR are required");
  process.exit(1);
}

async function main() {
  const nc = await connectTo(natsUrl!);
  const ctx = await makeCtx(nc);
  const db = await openProjectionDb(pgliteDir!);
  // Printed once the worker can actually apply events — the parent waits
  // for this before starting its "kill after a random delay" timer, so a
  // kill always has a real chance to land mid-apply rather than before the
  // process has even connected.
  console.log("READY");

  for (;;) {
    const checkpoint = await getCheckpoint(db, consumerName);
    if (targetSeq !== undefined && checkpoint >= targetSeq) {
      console.log(`DONE ${checkpoint}`);
      await db.close();
      await nc.close();
      process.exit(0);
    }
    const startSeq = checkpoint + 1;
    const consumer = await ctx.js.consumers.get("EVENTS", {
      filter_subjects: [filterSubject],
      deliver_policy: startSeq > 1 ? DeliverPolicy.StartSequence : DeliverPolicy.All,
      opt_start_seq: startSeq > 1 ? startSeq : undefined,
    });
    // Pull whatever is available right now; `expires` bounds how long we
    // wait for the next batch when the stream has nothing new yet, so the
    // loop above can re-check the target/checkpoint instead of blocking
    // forever on one pull.
    const iter = await consumer.consume({ max_messages: 1000, expires: 2000 });
    for await (const m of iter) {
      const event = decode<ConversationEvent>(m.data);
      await applyEventTransactionally(db, consumerName, m.seq, event);
      m.ack();
      // One line per applied event, flushed to stdout, so the parent can
      // see real progress (and, for the final run, spot the target being
      // reached) without polling the PGlite directory from another
      // process.
      console.log(`APPLIED ${m.seq}`);
      if (targetSeq !== undefined && m.seq >= targetSeq) {
        await iter.stop();
        break;
      }
    }
  }
}

main().catch((err) => {
  console.error("WORKER ERROR", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
