// Pass condition 5: scale. 1,000,000 distinct subjects with tiny payloads
// on a single node (R1, to save disk). Measures publish throughput, server
// RSS, disk used, the latency of an expected-last-subject-sequence publish
// once 1M subjects exist, and the latency to read one subject's full
// history. Deletes the data afterwards.
//
// SCALE_N overrides the subject count for a quick smoke run, e.g.
//   SCALE_N=20000 npx vitest run tests/05-scale-1m.test.ts
// The real pass condition is only claimed at the full 1,000,000.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DeliverPolicy } from "@nats-io/jetstream";
import { freePorts } from "../src/ports.ts";
import { freshStateDir, removeStateDir, startNatsServer, connectTo, type RunningNatsServer } from "../src/nats-proc.ts";
import { conditionalAppend, encode, ensureEventsStream, makeCtx, STREAM_NAME, type Ctx } from "../src/jetstream.ts";
import { runPool } from "../src/pool.ts";
import { rssBytes, dirSizeBytes, fmtBytes, Sampler } from "../src/measure.ts";

const execFileAsync = promisify(execFile);

const TOTAL_SUBJECTS = Number(process.env.SCALE_N ?? 1_000_000);
const CONCURRENCY = Number(process.env.SCALE_CONCURRENCY ?? 256);
const HOT_SUBJECT_STRIDE = Math.max(1, Math.floor(TOTAL_SUBJECTS / 20)); // ~20 "hot" subjects get extra history
const HOT_SUBJECT_EXTRA = 5; // + this many appends beyond the initial one

let server: RunningNatsServer;
let ctx: Ctx;
let stateDir: string;

function subjectFor(i: number): string {
  return `ev.scale.${i}`;
}

beforeAll(async () => {
  const { stdout: dfBefore } = await execFileAsync("df", ["-h", "/"]);
  console.log(`[t5] df -h / before:\n${dfBefore}`);

  stateDir = await freshStateDir("t5-scale-1m");
  const [port] = await freePorts(1);
  server = await startNatsServer({ name: "t5", port, storeDir: `${stateDir}/node` });
  const nc = await connectTo(server.url, { timeout: 10_000 });
  ctx = await makeCtx(nc);
  await ensureEventsStream(ctx.jsm, { replicas: 1 });
}, 60_000);

afterAll(async () => {
  await ctx?.nc?.close();
  await server?.stop();
  const dir = server?.storeDir;
  await removeStateDir(stateDir);
  if (dir) {
    const { stdout: dfAfter } = await execFileAsync("df", ["-h", "/"]).catch(() => ({ stdout: "" }));
    console.log(`[t5] df -h / after cleanup:\n${dfAfter}`);
  }
});

describe(`S0.7 pass condition 5: scale (N=${TOTAL_SUBJECTS.toLocaleString()} subjects)`, () => {
  it(
    "publishes N distinct subjects, measuring throughput/RSS/disk, then a conditional-append and a full-history-read latency",
    async () => {
      const rssSampler = new Sampler(() => rssBytes(server.proc.pid!), 500);
      rssSampler.start();

      const hotSubjectIndices = new Set<number>();
      for (let i = 0; i < TOTAL_SUBJECTS; i += HOT_SUBJECT_STRIDE) hotSubjectIndices.add(i);
      // Remember the ack sequence of a spread of ordinary subjects too, so
      // we can do a real conditional append against them afterwards.
      const sampleForLatency: number[] = [];
      const sampleStride = Math.max(1, Math.floor(TOTAL_SUBJECTS / 30));
      const lastAckSeq = new Map<number, number>();

      const t0 = Date.now();
      let published = 0;
      await runPool(TOTAL_SUBJECTS, CONCURRENCY, async (i) => {
        const subject = subjectFor(i);
        const res = await conditionalAppend(ctx.js, subject, encode({ i, t: Date.now() }), {
          expectedLastSubjectSequence: 0,
          msgId: `scale-${i}-0`,
        });
        if (!res.ok || !res.ack) throw new Error(`publish failed at i=${i}: ${res.errMessage}`);
        published++;
        if (i % sampleStride === 0) {
          lastAckSeq.set(i, res.ack.seq);
          sampleForLatency.push(i);
        }
      });
      const bulkMs = Date.now() - t0;
      const throughput = published / (bulkMs / 1000);
      console.log(
        `[t5] bulk load: ${published.toLocaleString()} publishes in ${bulkMs}ms => ${throughput.toFixed(0)} msgs/sec (concurrency=${CONCURRENCY})`,
      );
      expect(published).toBe(TOTAL_SUBJECTS);

      // Give a spread of "hot" subjects extra history so the full-history
      // read measurement below is on a subject with more than one message.
      const hotIndices = [...hotSubjectIndices].slice(0, 20);
      for (const i of hotIndices) {
        let expected = lastAckSeq.get(i);
        if (expected === undefined) {
          const direct = await ctx.jsm.direct.getMessage(STREAM_NAME, { last_by_subj: subjectFor(i) });
          expected = direct?.seq ?? 0;
        }
        for (let extra = 1; extra <= HOT_SUBJECT_EXTRA; extra++) {
          const res = await conditionalAppend(ctx.js, subjectFor(i), encode({ i, extra }), {
            expectedLastSubjectSequence: expected,
            msgId: `scale-${i}-${extra}`,
          });
          if (!res.ok || !res.ack) throw new Error(`hot-subject append failed at i=${i} extra=${extra}: ${res.errMessage}`);
          expected = res.ack.seq;
        }
        lastAckSeq.set(i, expected);
      }

      rssSampler.stop();
      const rss = rssSampler.stats();
      const diskBytes = await dirSizeBytes(server.storeDir);
      console.log(
        `[t5] server RSS during load: min=${fmtBytes(rss.min)} max=${fmtBytes(rss.max)} last=${fmtBytes(rss.last)} (${rss.count} samples)`,
      );
      console.log(`[t5] on-disk stream size: ${fmtBytes(diskBytes)} for ${TOTAL_SUBJECTS.toLocaleString()} subjects`);

      const info = await ctx.jsm.streams.info(STREAM_NAME);
      expect(info.state.num_subjects ?? info.state.messages).toBeGreaterThanOrEqual(TOTAL_SUBJECTS);
      console.log(
        `[t5] stream state: messages=${info.state.messages.toLocaleString()} num_subjects=${info.state.num_subjects ?? "n/a"} bytes=${fmtBytes(info.state.bytes)}`,
      );

      // --- Latency of a conditional append once N subjects exist ---
      const appendLatenciesMs: number[] = [];
      for (const i of sampleForLatency.slice(0, 30)) {
        const expected = lastAckSeq.get(i)!;
        const tA = performance.now();
        const res = await conditionalAppend(ctx.js, subjectFor(i), encode({ i, probe: true }), {
          expectedLastSubjectSequence: expected,
          msgId: `scale-probe-${i}`,
        });
        appendLatenciesMs.push(performance.now() - tA);
        expect(res.ok).toBe(true);
      }
      appendLatenciesMs.sort((a, b) => a - b);
      const p50 = appendLatenciesMs[Math.floor(appendLatenciesMs.length * 0.5)];
      const p99 = appendLatenciesMs[Math.floor(appendLatenciesMs.length * 0.99)];
      console.log(
        `[t5] conditional-append latency at N=${TOTAL_SUBJECTS.toLocaleString()} subjects: p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms (n=${appendLatenciesMs.length})`,
      );

      // --- Latency to read one subject's full history ---
      const hotSubject = subjectFor(hotIndices[0]);
      const tDirect = performance.now();
      const directMsg = await ctx.jsm.direct.getMessage(STREAM_NAME, { last_by_subj: hotSubject });
      const directLatencyMs = performance.now() - tDirect;
      expect(directMsg).not.toBeNull();
      console.log(`[t5] direct-get (last message for subject) latency: ${directLatencyMs.toFixed(2)}ms`);

      const tConsumer = performance.now();
      const consumer = await ctx.js.consumers.get(STREAM_NAME, {
        filter_subjects: [hotSubject],
        deliver_policy: DeliverPolicy.All,
      });
      const iter = await consumer.consume({ max_messages: HOT_SUBJECT_EXTRA + 5, expires: 2000 });
      let gotHistory = 0;
      for await (const m of iter) {
        gotHistory++;
        m.ack();
        if (gotHistory >= HOT_SUBJECT_EXTRA + 1) break;
      }
      await iter.stop();
      const consumerLatencyMs = performance.now() - tConsumer;
      expect(gotHistory).toBe(HOT_SUBJECT_EXTRA + 1);
      console.log(
        `[t5] consumer read of one subject's full history (${gotHistory} messages) latency: ${consumerLatencyMs.toFixed(2)}ms`,
      );
    },
    30 * 60 * 1000,
  );
});
