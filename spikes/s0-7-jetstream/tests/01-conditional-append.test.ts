// Pass condition 1: conditional append + de-duplication.
//
// - N concurrent writers race to append the FIRST message on one subject,
//   all using Nats-Expected-Last-Subject-Sequence. Exactly one must win;
//   the rest must get the "wrong last sequence" error (10071). Losers then
//   reload the true last sequence and retry, round after round, until the
//   subject has exactly N messages with no gaps and no duplicates.
// - A second publish reusing the same Nats-Msg-Id within the duplicate
//   window must be reported as a duplicate by the server, not stored again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePorts } from "../src/ports.ts";
import { freshStateDir, removeStateDir, startNatsServer, connectTo, type RunningNatsServer } from "../src/nats-proc.ts";
import { conditionalAppend, encode, ensureEventsStream, makeCtx, STREAM_WRONG_LAST_SEQUENCE, type Ctx } from "../src/jetstream.ts";
import { DeliverPolicy } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";

let server: RunningNatsServer;
let nc: NatsConnection;
let ctx: Ctx;
let stateDir: string;

beforeAll(async () => {
  stateDir = await freshStateDir("t1-conditional-append");
  const [port] = await freePorts(1);
  server = await startNatsServer({ name: "t1", port, storeDir: `${stateDir}/node` });
  nc = await connectTo(server.url);
  ctx = await makeCtx(nc);
  await ensureEventsStream(ctx.jsm, { replicas: 1 });
});

afterAll(async () => {
  await nc?.close();
  await server?.stop();
  await removeStateDir(stateDir);
});

describe("S0.7 pass condition 1: conditional append + de-duplication", () => {
  it("lets exactly one of N concurrent first-writers win, and reload-and-retry converges", async () => {
    const subject = "ev.conversation.concurrency-test";
    const N = 20;

    // Round 1: everyone races to be message #1 on this subject.
    const round1 = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        conditionalAppend(ctx.js, subject, encode({ writer: i, attempt: 1 }), {
          expectedLastSubjectSequence: 0,
          msgId: `writer-${i}-attempt-1`,
        }),
      ),
    );
    const firstRoundWinners = round1.filter((r) => r.ok);
    const firstRoundLosers = round1.filter((r) => !r.ok);
    expect(firstRoundWinners).toHaveLength(1);
    expect(firstRoundLosers).toHaveLength(N - 1);
    for (const loss of firstRoundLosers) {
      expect(loss.errCode).toBe(STREAM_WRONG_LAST_SEQUENCE);
    }

    // Reload-and-retry: losers keep re-reading the true last sequence and
    // re-publishing against it, round after round, like a real command
    // handler would. Track rounds needed to converge.
    let outstanding = firstRoundLosers.map((_, idx) => idx).length; // count only, identity doesn't matter
    let pendingWriterIds = Array.from({ length: N - 1 }, (_, i) => i); // relabel remaining writers 0..N-2
    let rounds = 1;
    const maxRounds = N + 5;

    while (pendingWriterIds.length > 0 && rounds < maxRounds) {
      rounds++;
      // Everyone still pending reads the CURRENT last sequence for the
      // subject (a real handler would read its projection + stored
      // sequence; here we ask JetStream directly via a direct-get, which is
      // the same fact a handler's read would be based on).
      const lastMsg = await ctx.jsm.direct.getMessage("EVENTS", { last_by_subj: subject });
      const currentLastSeq = lastMsg?.seq ?? 0;

      const attempts = await Promise.all(
        pendingWriterIds.map((id) =>
          conditionalAppend(ctx.js, subject, encode({ writer: `retry-${id}`, attempt: rounds }), {
            expectedLastSubjectSequence: currentLastSeq,
            msgId: `writer-retry-${id}-round-${rounds}`,
          }),
        ),
      );
      const won = new Set<number>();
      attempts.forEach((r, i) => {
        if (r.ok) won.add(pendingWriterIds[i]);
        else expect(r.errCode).toBe(STREAM_WRONG_LAST_SEQUENCE);
      });
      // Exactly one writer should win each contested round (or possibly
      // zero if, by race, two both read the same currentLastSeq and both
      // lost to each other — but with N-1 down to 1 contenders and a
      // single server, at least one always gets seq currentLastSeq+1).
      expect(won.size).toBeGreaterThanOrEqual(1);
      pendingWriterIds = pendingWriterIds.filter((id) => !won.has(id));
    }

    expect(pendingWriterIds).toHaveLength(0);

    // Final state: exactly N messages on the subject, strictly 1..N, no
    // gaps, no duplicates.
    const consumer = await ctx.js.consumers.get("EVENTS", {
      filter_subjects: [subject],
      deliver_policy: DeliverPolicy.All,
    });
    const seen: number[] = [];
    const iter = await consumer.consume({ max_messages: N + 5, expires: 3000 });
    for await (const m of iter) {
      seen.push(m.seq);
      m.ack();
      if (seen.length >= N) break;
    }
    await iter.stop();
    seen.sort((a, b) => a - b);
    expect(seen).toHaveLength(N);
    // Contiguous run: last - first + 1 === N, and no duplicate values.
    expect(new Set(seen).size).toBe(N);
    expect(seen[seen.length - 1] - seen[0] + 1).toBe(N);

    console.log(`[t1] concurrency: ${N} writers converged in ${rounds} round(s) of reload-and-retry`);
  });

  it("de-duplicates a re-sent Nats-Msg-Id within the duplicate window", async () => {
    const subject = "ev.conversation.dedup-test";
    const first = await conditionalAppend(ctx.js, subject, encode({ n: 1 }), {
      expectedLastSubjectSequence: 0,
      msgId: "dedup-fixed-id",
    });
    expect(first.ok).toBe(true);
    expect(first.ack?.duplicate).toBe(false);
    const firstSeq = first.ack?.seq as number;

    // Re-send the exact same Nats-Msg-Id with the CORRECT current expected
    // sequence (the resend must not have moved the subject's sequence on).
    // The server recognises it as a duplicate and returns the same seq
    // without storing a second message.
    const second = await conditionalAppend(ctx.js, subject, encode({ n: 1 }), {
      expectedLastSubjectSequence: firstSeq,
      msgId: "dedup-fixed-id",
    });
    expect(second.ok).toBe(true);
    expect(second.ack?.duplicate).toBe(true);
    expect(second.ack?.seq).toBe(firstSeq);

    const info = await ctx.jsm.streams.info("EVENTS", { subjects_filter: subject });
    expect(info.state.subjects?.[subject]).toBe(1);

    // Finding worth recording: Nats-Msg-Id de-duplication does NOT override
    // a mismatched expected-sequence. If the resend carries a stale expected
    // sequence, the server rejects it as a sequence mismatch BEFORE it ever
    // gets to check the msg id — the caller must use the sequence its own
    // successful write actually landed at (or the current true sequence),
    // not whatever it originally intended.
    const thirdStaleExpect = await conditionalAppend(ctx.js, subject, encode({ n: 1 }), {
      expectedLastSubjectSequence: 0, // stale on purpose: real last seq is firstSeq
      msgId: "dedup-fixed-id",
    });
    expect(thirdStaleExpect.ok).toBe(false);
    expect(thirdStaleExpect.errCode).toBe(STREAM_WRONG_LAST_SEQUENCE);
  });
});
