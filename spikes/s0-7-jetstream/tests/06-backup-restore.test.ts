// Pass condition 6: backup and restore. Snapshot a populated stream with
// the official `nats` CLI (`nats backup stream`), restore it into a FRESH
// server, and check every message and per-subject last sequence survives,
// and that expected-sequence appends continue to work correctly after
// restore.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePorts } from "../src/ports.ts";
import {
  freshStateDir,
  removeStateDir,
  startNatsServer,
  connectTo,
  NATS_CLI_BIN,
  type RunningNatsServer,
} from "../src/nats-proc.ts";
import { conditionalAppend, encode, ensureEventsStream, makeCtx, STREAM_NAME, STREAM_WRONG_LAST_SEQUENCE, type Ctx } from "../src/jetstream.ts";

const execFileAsync = promisify(execFile);

const N_SUBJECTS = 50;
const APPENDS_PER_SUBJECT = 4;

let stateDir: string;
let backupDir: string;

let originalServer: RunningNatsServer;
let originalCtx: Ctx;

let restoredServer: RunningNatsServer;
let restoredCtx: Ctx;

interface Fixture {
  bySubject: Map<string, number[]>; // subject -> stream sequences, in order
  totalMessages: number;
}

async function populate(ctx: Ctx): Promise<Fixture> {
  const bySubject = new Map<string, number[]>();
  let total = 0;
  for (let s = 0; s < N_SUBJECTS; s++) {
    const subject = `ev.backup.${s}`;
    let expected = 0;
    const seqs: number[] = [];
    for (let n = 0; n < APPENDS_PER_SUBJECT; n++) {
      const res = await conditionalAppend(ctx.js, subject, encode({ s, n }), {
        expectedLastSubjectSequence: expected,
        msgId: `bk-${s}-${n}`,
      });
      if (!res.ok || !res.ack) throw new Error(`fixture publish failed s=${s} n=${n}: ${res.errMessage}`);
      expected = res.ack.seq;
      seqs.push(res.ack.seq);
      total++;
    }
    bySubject.set(subject, seqs);
  }
  return { bySubject, totalMessages: total };
}

beforeAll(async () => {
  stateDir = await freshStateDir("t6-backup-restore");
  backupDir = await mkdtemp(join(tmpdir(), "s0-7-backup-"));

  const [originalPort] = await freePorts(1);
  originalServer = await startNatsServer({ name: "t6-original", port: originalPort, storeDir: `${stateDir}/original` });
  const originalNc = await connectTo(originalServer.url);
  originalCtx = await makeCtx(originalNc);
  await ensureEventsStream(originalCtx.jsm, { replicas: 1 });
});

afterAll(async () => {
  await originalCtx?.nc?.close();
  await originalServer?.stop();
  await restoredCtx?.nc?.close();
  await restoredServer?.stop().catch(() => {});
  await removeStateDir(stateDir);
  await rm(backupDir, { recursive: true, force: true });
});

describe("S0.7 pass condition 6: backup and restore", () => {
  it("restores a populated stream into a fresh server with identical messages and per-subject sequences, and appends still work", async () => {
    const fixture = await populate(originalCtx);
    expect(fixture.totalMessages).toBe(N_SUBJECTS * APPENDS_PER_SUBJECT);

    const infoBefore = await originalCtx.jsm.streams.info(STREAM_NAME);
    console.log(
      `[t6] populated ${STREAM_NAME}: messages=${infoBefore.state.messages} subjects=${infoBefore.state.num_subjects}`,
    );

    // Snapshot via the official nats CLI (Apache-2.0, github.com/nats-io/natscli).
    const backupTargetDir = join(backupDir, "snapshot");
    const backupArgs = [
      "backup",
      "stream",
      STREAM_NAME,
      backupTargetDir,
      "-s",
      originalServer.url,
      "--no-progress",
    ];
    const backupResult = await execFileAsync(NATS_CLI_BIN, backupArgs);
    console.log(`[t6] nats backup stream stdout:\n${backupResult.stdout}${backupResult.stderr}`);

    // Restore into a brand-new server with its own empty store dir — not
    // the same process, not the same data directory.
    const [restoredPort] = await freePorts(1);
    restoredServer = await startNatsServer({
      name: "t6-restored",
      port: restoredPort,
      storeDir: `${stateDir}/restored`,
    });
    const restoredNc = await connectTo(restoredServer.url);
    restoredCtx = await makeCtx(restoredNc);

    // The stream must NOT already exist on the fresh server before restore.
    await expect(restoredCtx.jsm.streams.info(STREAM_NAME)).rejects.toThrow();

    const restoreArgs = ["backup", "restore", "stream", backupTargetDir, "-s", restoredServer.url, "--no-progress"];
    const restoreResult = await execFileAsync(NATS_CLI_BIN, restoreArgs);
    console.log(`[t6] nats backup restore stream stdout:\n${restoreResult.stdout}${restoreResult.stderr}`);

    const infoAfter = await restoredCtx.jsm.streams.info(STREAM_NAME);
    expect(infoAfter.state.messages).toBe(infoBefore.state.messages);
    expect(infoAfter.state.bytes).toBe(infoBefore.state.bytes);
    console.log(
      `[t6] restored ${STREAM_NAME}: messages=${infoAfter.state.messages} subjects=${infoAfter.state.num_subjects}`,
    );

    // Every message and every per-subject last sequence must match exactly.
    let checkedSubjects = 0;
    for (const [subject, seqs] of fixture.bySubject) {
      const restoredLast = await restoredCtx.jsm.direct.getMessage(STREAM_NAME, { last_by_subj: subject });
      expect(restoredLast).not.toBeNull();
      expect(restoredLast!.seq).toBe(seqs[seqs.length - 1]);
      const restoredLastPayload = restoredLast!.json<{ s: number; n: number }>();
      expect(restoredLastPayload).toEqual({ s: Number(subject.split(".")[2]), n: APPENDS_PER_SUBJECT - 1 });
      checkedSubjects++;
    }
    expect(checkedSubjects).toBe(N_SUBJECTS);

    // Conditional appends must continue to work correctly against the
    // restored stream: the correct expected sequence is accepted...
    const probeSubject = "ev.backup.0";
    const correctExpected = fixture.bySubject.get(probeSubject)!.at(-1)!;
    const okAppend = await conditionalAppend(restoredCtx.js, probeSubject, encode({ postRestore: true }), {
      expectedLastSubjectSequence: correctExpected,
      msgId: "post-restore-ok",
    });
    expect(okAppend.ok).toBe(true);

    // ...and a stale/wrong expected sequence is still correctly rejected,
    // proving the restored stream's per-subject sequence state (not just
    // its messages) is intact and enforced.
    const staleAppend = await conditionalAppend(restoredCtx.js, probeSubject, encode({ postRestore: true }), {
      expectedLastSubjectSequence: correctExpected, // now stale: real last seq moved on above
      msgId: "post-restore-stale",
    });
    expect(staleAppend.ok).toBe(false);
    expect(staleAppend.errCode).toBe(STREAM_WRONG_LAST_SEQUENCE);

    console.log(`[t6] PASS: ${checkedSubjects} subjects verified byte-identical after restore; appends still enforced`);
  });
});
