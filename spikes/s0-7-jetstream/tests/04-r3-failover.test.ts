// Pass condition 4: R3 failover. A real 3-node local cluster (three
// nats-server processes, JetStream enabled, separate store directories),
// stream replicated 3 ways. Writers keep appending per-subject sequences
// across ~1,000 subjects while we find the actual RAFT stream leader and
// kill -9 it mid-run, then restart it. We check: every acknowledged publish
// is present after the dust settles, per-subject order is intact, there are
// no duplicates, and we measure the write-unavailability window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliverPolicy } from "@nats-io/jetstream";
import { freePorts } from "../src/ports.ts";
import {
  freshStateDir,
  removeStateDir,
  startNatsServer,
  connectTo,
  type RunningNatsServer,
  type NatsServerOptions,
} from "../src/nats-proc.ts";
import { appendWithRetry, decode, encode, ensureEventsStream, makeCtx, STREAM_NAME, type Ctx } from "../src/jetstream.ts";
import type { NatsConnection } from "@nats-io/nats-core";

const N_SUBJECTS = 1000;
const CHAIN_LEN = 3; // events per subject
const LANES = 30; // concurrent writer "lanes"
const TOTAL_APPENDS = N_SUBJECTS * CHAIN_LEN;
const CLUSTER_NAME = "s0-7-cluster";

let stateDir: string;
let servers: Map<string, { opts: NatsServerOptions; running: RunningNatsServer }>;
let clientNc: NatsConnection; // multi-server client used for the actual test
let ctx: Ctx;

async function currentLeaderName(): Promise<string | undefined> {
  const info = await ctx.jsm.streams.info(STREAM_NAME);
  return info.cluster?.leader;
}

beforeAll(async () => {
  stateDir = await freshStateDir("t4-r3-failover");
  const ports = await freePorts(3);
  const clusterPorts = await freePorts(3);
  const names = ["t4-node-0", "t4-node-1", "t4-node-2"];
  const peers = names.map((name, i) => ({ name, port: ports[i], clusterPort: clusterPorts[i] }));

  servers = new Map();
  for (let i = 0; i < 3; i++) {
    const opts: NatsServerOptions = {
      name: names[i],
      port: ports[i],
      storeDir: `${stateDir}/${names[i]}`,
      cluster: { name: CLUSTER_NAME, clusterPort: clusterPorts[i], peers },
    };
    const running = await startNatsServer(opts);
    servers.set(names[i], { opts, running });
  }

  const allUrls = peers.map((p) => `127.0.0.1:${p.port}`);
  clientNc = await connectTo(allUrls);

  // Cluster routes need a moment to connect and elect a metadata leader.
  // `makeCtx` itself calls `jetstreamManager`, which calls `getAccountInfo`
  // — that call needs a meta leader too, so it must be INSIDE this retry
  // loop, not run once before it. Calling it too early throws a
  // TimeoutError (no meta leader yet), which used to fail the whole test
  // in beforeAll with no retry. Retry the whole "get a JetStream context,
  // then create the replicated stream" sequence together rather than
  // guessing a fixed sleep.
  const deadline = Date.now() + 20_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      ctx = await makeCtx(clientNc);
      await ensureEventsStream(ctx.jsm, { replicas: 3, subjects: ["ev.>"] });
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (lastErr) throw new Error(`could not create R3 stream: ${String(lastErr)}`);

  // Wait until the stream actually reports a cluster leader and all peers
  // current, i.e. the cluster is genuinely settled, not just "accepted".
  const settleDeadline = Date.now() + 20_000;
  while (Date.now() < settleDeadline) {
    const info = await ctx.jsm.streams.info(STREAM_NAME);
    const allCurrent = (info.cluster?.replicas ?? []).every((r) => r.current);
    if (info.cluster?.leader && allCurrent) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}, 60_000);

afterAll(async () => {
  await clientNc?.close();
  for (const { running } of servers.values()) {
    await running.stop("SIGTERM").catch(() => {});
  }
  await removeStateDir(stateDir);
});

describe("S0.7 pass condition 4: R3 failover", () => {
  it(
    "survives a hard kill of the RAFT leader mid-run with no lost, reordered or duplicated writes",
    async () => {
      const leaderBefore = await currentLeaderName();
      expect(leaderBefore).toBeDefined();
      console.log(`[t4] cluster settled; leader before kill = ${leaderBefore}`);

      // --- Heartbeat prober: measures the write-unavailability window ---
      const heartbeatSubject = "ev.heartbeat.probe";
      let heartbeatExpected = 0;
      const heartbeatLog: Array<{ t: number; ok: boolean }> = [];
      let stopProbe = false;
      const probeLoop = (async () => {
        let n = 0;
        while (!stopProbe) {
          n++;
          const t0 = Date.now();
          try {
            const { ack } = await appendWithRetry(ctx, heartbeatSubject, () => encode({ n }), {
              expectedLastSubjectSequence: heartbeatExpected,
              msgId: `hb-${n}`,
              maxAttempts: 1, // we want to observe individual failures, not auto-retry
              retryDelayMs: 0,
            }).then(
              (r) => ({ ack: r.ack, ok: true as const }),
              (err) => ({ ack: undefined, ok: false as const, err }),
            );
            if (ack) {
              heartbeatExpected = ack.seq;
              heartbeatLog.push({ t: t0, ok: true });
            } else {
              heartbeatLog.push({ t: t0, ok: false });
            }
          } catch {
            heartbeatLog.push({ t: t0, ok: false });
          }
          await new Promise((r) => setTimeout(r, 40));
        }
      })();

      // --- Bulk writers: 1,000 subjects x 3 chained events, 30 lanes ---
      const subjects = Array.from({ length: N_SUBJECTS }, (_, i) => `ev.failover.${i}`);
      const progress = { success: 0 };
      const acked: Array<{ subject: string; n: number; msgId: string; ackSeq: number }> = [];

      async function runLane(laneSubjects: string[]) {
        for (const subject of laneSubjects) {
          let expected = 0;
          for (let n = 0; n < CHAIN_LEN; n++) {
            const msgId = `${subject}-${n}`;
            const { ack } = await appendWithRetry(ctx, subject, () => encode({ n, msgId }), {
              expectedLastSubjectSequence: expected,
              msgId,
              maxAttempts: 300,
              retryDelayMs: 60,
            });
            expected = ack.seq;
            acked.push({ subject, n, msgId, ackSeq: ack.seq });
            progress.success++;
          }
        }
      }

      const lanes: string[][] = Array.from({ length: LANES }, () => []);
      subjects.forEach((s, i) => lanes[i % LANES].push(s));
      const bulkRun = Promise.all(lanes.map(runLane));

      // Kill the leader once real progress has been made (not at t=0), so
      // the kill genuinely lands "mid-run".
      while (progress.success < TOTAL_APPENDS * 0.2) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const leaderName = await currentLeaderName();
      expect(leaderName).toBeDefined();
      const victim = servers.get(leaderName!)!;
      const killedAt = Date.now();
      console.log(`[t4] killing leader '${leaderName}' at progress ${progress.success}/${TOTAL_APPENDS}`);
      victim.running.proc.kill("SIGKILL");
      await victim.running.exited;

      // Let the bulk writers keep going (retrying through the election),
      // and restart the killed node a little after the kill, same as an
      // operator bringing a crashed node back.
      await new Promise((r) => setTimeout(r, 1500));
      const restarted = await startNatsServer(victim.opts);
      servers.set(leaderName!, { opts: victim.opts, running: restarted });
      console.log(`[t4] restarted '${leaderName}'`);

      await bulkRun;
      stopProbe = true;
      await probeLoop;

      const newLeader = await currentLeaderName();
      console.log(`[t4] all writers done; leader after = ${newLeader} (changed: ${newLeader !== leaderBefore})`);

      // --- Availability window from the heartbeat log ---
      heartbeatLog.sort((a, b) => a.t - b.t);
      const failuresAfterKill = heartbeatLog.filter((h) => !h.ok && h.t >= killedAt);
      let downtimeMs = 0;
      if (failuresAfterKill.length > 0) {
        const firstFailure = failuresAfterKill[0].t;
        const nextSuccess = heartbeatLog.find((h) => h.ok && h.t > firstFailure);
        downtimeMs = (nextSuccess ? nextSuccess.t : Date.now()) - firstFailure;
      }
      console.log(
        `[t4] write-unavailability window ~= ${downtimeMs}ms (${failuresAfterKill.length} failed heartbeat attempt(s) around the kill)`,
      );

      // Wait for the restarted node to rejoin and catch up before reading
      // back final state from the cluster.
      const rejoinDeadline = Date.now() + 20_000;
      while (Date.now() < rejoinDeadline) {
        const info = await ctx.jsm.streams.info(STREAM_NAME);
        if ((info.cluster?.replicas ?? []).every((r) => r.current)) break;
        await new Promise((r) => setTimeout(r, 300));
      }

      // --- Correctness checks ---
      expect(progress.success).toBe(TOTAL_APPENDS);
      expect(acked).toHaveLength(TOTAL_APPENDS);

      // Read back everything under ev.failover.> in one ordered pass.
      const consumer = await ctx.js.consumers.get(STREAM_NAME, {
        filter_subjects: ["ev.failover.>"],
        deliver_policy: DeliverPolicy.All,
      });
      const iter = await consumer.consume({ max_messages: TOTAL_APPENDS + 10, expires: 3000 });
      const bySubject = new Map<string, Array<{ n: number; msgId: string; seq: number }>>();
      let seen = 0;
      for await (const m of iter) {
        const payload = decode<{ n: number; msgId: string }>(m.data);
        const arr = bySubject.get(m.subject) ?? [];
        arr.push({ n: payload.n, msgId: payload.msgId, seq: m.seq });
        bySubject.set(m.subject, arr);
        m.ack();
        seen++;
        if (seen >= TOTAL_APPENDS) break;
      }
      await iter.stop();

      expect(seen).toBe(TOTAL_APPENDS);
      expect(bySubject.size).toBe(N_SUBJECTS);

      // Every acknowledged write must be present (no acked-but-lost writes)
      // and de-duplicated (retries reuse the same Nats-Msg-Id, so a
      // redelivered retry must not create a second stored message).
      const storedMsgIds = new Set<string>();
      let outOfOrderSubjects = 0;
      for (const [subject, entries] of bySubject) {
        entries.sort((a, b) => a.seq - b.seq);
        entries.forEach((e) => storedMsgIds.add(e.msgId));
        const ns = entries.map((e) => e.n);
        const isStrictlyOrdered = ns.every((v, i) => v === i);
        if (!isStrictlyOrdered) {
          outOfOrderSubjects++;
          console.log(`[t4] OUT OF ORDER on ${subject}: ${JSON.stringify(ns)}`);
        }
        expect(entries).toHaveLength(CHAIN_LEN); // no duplicates AND no gaps
      }
      expect(outOfOrderSubjects).toBe(0);

      for (const a of acked) {
        expect(storedMsgIds.has(a.msgId)).toBe(true);
      }

      console.log(
        `[t4] PASS: ${seen} events across ${bySubject.size} subjects, all ordered, none lost, none duplicated`,
      );
    },
    5 * 60 * 1000,
  );
});
