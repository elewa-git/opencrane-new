// Pass condition 2: ordered replay into a projection, with the consumer's
// checkpoint written in the SAME Postgres transaction as the projection
// row, surviving a REAL crash mid-stream with no double-apply and no skip.
//
// "Real crash" here means: the projection loop runs in its own OS process
// (src/projection-worker.ts, spawned via src/worker-proc.ts), and the test
// sends it SIGKILL — the same signal a container scheduler or OOM killer
// would send. The process gets no chance to run cleanup code, close its
// consumer, or finish a transaction. This is done at least 10 times, at
// random points, while conversation events AND interleaved noise (on
// subjects the projection's filter must ignore) are still being published,
// each noise subject using its own correctly-tracked expected sequence —
// not a hard-coded 0, which would make every noise publish after the first
// one on a given subject fail silently.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePorts } from "../src/ports.ts";
import { freshStateDir, removeStateDir, startNatsServer, connectTo, type RunningNatsServer } from "../src/nats-proc.ts";
import { conditionalAppend, encode, ensureEventsStream, makeCtx, type Ctx } from "../src/jetstream.ts";
import { openProjectionDb, dumpProjection, processedEventCount, getCheckpoint, type ConversationEvent } from "../src/projection.ts";
import { spawnProjectionWorker, countMatching } from "../src/worker-proc.ts";
import type { NatsConnection } from "@nats-io/nats-core";

let server: RunningNatsServer;
let nc: NatsConnection;
let ctx: Ctx;
let stateDir: string;
const CONSUMER_NAME = "conversation-projection";

const TOTAL_CONVERSATION_EVENTS = 500;
const NOISE_SUBJECTS = ["ev.budget.acme", "ev.member.alice", "ev.team.sales"];
const MIN_KILLS = 10;

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

/** Publishes the 500 conversation events plus interleaved noise on 3 other
 * subjects, each noise subject tracked with its OWN running expected
 * sequence (so every noise publish actually lands, not just the first one
 * per subject). A small per-event delay spreads the publishing out over a
 * few seconds so it genuinely overlaps with the concurrently-running kill
 * loop, rather than finishing before the first kill happens. */
async function publishFixtureWithNoise(): Promise<{ published: Published[]; noiseLanded: number }> {
  const published: Published[] = [];
  const conversationIds = ["conv-a", "conv-b", "conv-c"];
  const seqBySubject = new Map<string, number>();
  const noiseSeqBySubject = new Map<string, number>(NOISE_SUBJECTS.map((s) => [s, 0]));
  let noiseLanded = 0;

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

    // Noise on subjects the projection's filtered consumer does NOT match —
    // proves subject-prefix filtering actually works. Each noise subject
    // uses the REAL current expected sequence, read back from the map we
    // update on every successful publish, so every noise event lands
    // instead of only the first one per subject.
    if (i % 2 === 0) {
      const noiseSubject = NOISE_SUBJECTS[i % NOISE_SUBJECTS.length];
      const expectedNoise = noiseSeqBySubject.get(noiseSubject)!;
      const noiseRes = await conditionalAppend(ctx.js, noiseSubject, encode({ noise: i }), {
        expectedLastSubjectSequence: expectedNoise,
        msgId: `noise-${noiseSubject}-${i}`,
      });
      if (!noiseRes.ok || !noiseRes.ack) {
        throw new Error(`noise publish on ${noiseSubject} failed: ${noiseRes.errMessage}`);
      }
      noiseSeqBySubject.set(noiseSubject, noiseRes.ack.seq);
      noiseLanded++;
    }

    // Spread the 500 publishes over a few seconds so the kill loop running
    // concurrently gets real chances to kill the worker while genuinely
    // new events are still arriving, not just against a static backlog.
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 25));
  }
  return { published, noiseLanded };
}

/** Expected final projection, computed independently in plain JS, to check
 * the PGlite-built projection against. Noise events never touch this. */
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

function workerEnv(pgliteDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    WORKER_NATS_URL: server.url,
    NATS_CERT_FILE: process.env.NATS_PROJECTION_CERT_FILE!,
    NATS_KEY_FILE: process.env.NATS_PROJECTION_KEY_FILE!,
    WORKER_PGLITE_DIR: pgliteDir,
    WORKER_FILTER_SUBJECT: "ev.conversation.>",
    WORKER_CONSUMER_NAME: CONSUMER_NAME,
    ...extra,
  };
}

/** Runs the worker process MIN_KILLS times, SIGKILLing each copy at a
 * random point after it becomes READY (i.e. after it has connected and
 * opened its PGlite directory), so each kill has a real chance of landing
 * mid-apply. Returns, per kill, how many events it had applied before
 * being killed (0 is allowed — that's still a valid "random point" — but
 * most should be > 0 to show genuine mid-stream kills). */
async function runKillLoop(pgliteDir: string): Promise<number[]> {
  const appliedBeforeKill: number[] = [];
  for (let k = 0; k < MIN_KILLS; k++) {
    const handle = spawnProjectionWorker(workerEnv(pgliteDir));
    try {
      await handle.waitFor(/^READY$/, 15_000);
    } catch (err) {
      // Even a kill before READY is a legitimate "random point" (crash
      // during startup) — but log it, don't silently swallow a real bug.
      console.log(`[t2] kill ${k}: worker never reported READY (${String(err)}); killing anyway`);
    }
    // A short random delay after READY so the kill lands at a different
    // point in the stream each time, rather than always at the very start.
    await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 350)));
    const appliedSoFar = countMatching(handle, /^APPLIED /);
    appliedBeforeKill.push(appliedSoFar);
    handle.child.kill("SIGKILL");
    await handle.exited;
  }
  return appliedBeforeKill;
}

describe("S0.7 pass condition 2: ordered replay into a projection, crash-safe", () => {
  it(
    "resumes from the transactional checkpoint after >=10 REAL process kills, with interleaved noise, no double-apply and no skip",
    async () => {
      const dbDir = `${stateDir}/pglite-projection`;

      const [{ published, noiseLanded }, appliedBeforeKill] = await Promise.all([
        publishFixtureWithNoise(),
        runKillLoop(dbDir),
      ]);
      const expected = expectedProjection(published);
      const lastConversationSeq = published[published.length - 1].streamSeq;

      console.log(
        `[t2] ${MIN_KILLS} real SIGKILLs done; events applied before each kill: [${appliedBeforeKill.join(", ")}]`,
      );
      const killsWithRealProgress = appliedBeforeKill.filter((n) => n > 0).length;
      console.log(`[t2] ${killsWithRealProgress}/${MIN_KILLS} kills had >=1 event already applied (genuine mid-stream kill)`);
      console.log(`[t2] noise events landed: ${noiseLanded} (across ${NOISE_SUBJECTS.length} subjects, correctly-sequenced)`);

      // The fix under test: every noise publish should land, not just the
      // first one per subject (that would happen if the expected sequence
      // were hard-coded to 0 instead of tracked per subject).
      expect(noiseLanded).toBeGreaterThan(NOISE_SUBJECTS.length);
      // Real interleaving, not all-kills-before-anything-happens.
      expect(killsWithRealProgress).toBeGreaterThan(0);

      // Final, un-killed run: let the worker catch up on whatever backlog
      // remains and exit cleanly once its checkpoint reaches the last
      // published conversation event's stream sequence.
      const finalHandle = spawnProjectionWorker(
        workerEnv(dbDir, { WORKER_TARGET_SEQ: String(lastConversationSeq) }),
      );
      await finalHandle.waitFor(new RegExp(`^DONE ${lastConversationSeq}$`), 60_000);
      const finalExitCode = await finalHandle.exited;
      expect(finalExitCode).toBe(0);

      // Now that no worker process is running, open the PGlite directory
      // directly from the test process and check the final state.
      const db = await openProjectionDb(dbDir);
      const finalCheckpoint = await getCheckpoint(db, CONSUMER_NAME);
      const totalApplied = await processedEventCount(db);
      const actualProjection = await dumpProjection(db);
      const appliedEventIds = (
        await db.query<{ event_id: string }>(`SELECT event_id FROM processed_events ORDER BY stream_seq`)
      ).rows.map((r) => r.event_id);
      await db.close();

      // No skip: every published conversation event was eventually applied.
      expect(totalApplied).toBe(TOTAL_CONVERSATION_EVENTS);
      expect(finalCheckpoint).toBe(lastConversationSeq);
      // No double-apply: `processed_events` has a PRIMARY KEY on event_id,
      // so a re-application under any kill timing would have thrown inside
      // the transaction and failed this test before we ever got here.
      // Belt-and-braces: the set of applied event ids is exactly the set
      // of published ones, with no repeats and nothing missing.
      expect(new Set(appliedEventIds).size).toBe(TOTAL_CONVERSATION_EVENTS);
      expect([...appliedEventIds].sort()).toEqual(published.map((p) => p.event.eventId).sort());
      expect(actualProjection).toEqual(expected);
    },
    5 * 60 * 1000,
  );
});
