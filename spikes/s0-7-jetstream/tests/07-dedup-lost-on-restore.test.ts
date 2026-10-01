// New pass condition found during S0.7 review, not in the original plan.md
// table: `Nats-Msg-Id` de-duplication state is lost on backup/restore, and
// a command retried after a restore (or simply after the duplicate window
// has passed) can silently create a duplicate EFFECT if the only thing
// protecting it is JetStream's own de-dup header. This test:
//
// 1. Proves the loss: the same `Nats-Msg-Id`, resent after a restore with
//    the correct current expected sequence, is accepted as a brand-new
//    message (`duplicate: false`) instead of being recognised as a repeat.
// 2. Proves the hazard: a "naive retry" that relies only on that header —
//    exactly the pattern `appendWithRetry` uses when it reloads the true
//    sequence after a rejection — creates a second, duplicate event after
//    a restore.
// 3. Proves the fix: the SAME retried command, routed through
//    `idempotentAppend` (src/idempotent-command.ts) backed by a command
//    ledger that lives in Postgres content (never touched by the
//    JetStream backup/restore under test), is recognised as already
//    processed and appends nothing.
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
  cliTlsArgs,
  type RunningNatsServer,
} from "../src/nats-proc.ts";
import { conditionalAppend, encode, ensureEventsStream, makeCtx, STREAM_NAME, type Ctx } from "../src/jetstream.ts";
import { openCommandLedger, idempotentAppend } from "../src/idempotent-command.ts";
import type { PGlite } from "@electric-sql/pglite";

const execFileAsync = promisify(execFile);

let stateDir: string;
let backupDir: string;
let originalServer: RunningNatsServer;
let originalCtx: Ctx;
let ledger: PGlite;
// Each test in this file restores into its OWN fresh server (a restore
// must land on an empty store dir); every one of them is tracked here and
// closed in afterAll, so nothing is left running.
const restoredServers: Array<{ server: RunningNatsServer; ctx: Ctx }> = [];

beforeAll(async () => {
  stateDir = await freshStateDir("t7-dedup-lost-on-restore");
  backupDir = await mkdtemp(join(tmpdir(), "s0-7-dedup-backup-"));

  const [originalPort] = await freePorts(1);
  originalServer = await startNatsServer({ name: "t7-original", port: originalPort, storeDir: `${stateDir}/original` });
  const originalNc = await connectTo(originalServer.url);
  originalCtx = await makeCtx(originalNc);
  await ensureEventsStream(originalCtx.jsm, { replicas: 1 });

  // The command ledger is Postgres CONTENT, backed up on its own schedule,
  // independent of JetStream. Deliberately never touched by the JetStream
  // backup/restore below, to model that reality honestly.
  ledger = await openCommandLedger(`${stateDir}/ledger`);
});

afterAll(async () => {
  await originalCtx?.nc?.close();
  await originalServer?.stop();
  for (const { server, ctx } of restoredServers) {
    await ctx?.nc?.close().catch(() => {});
    await server?.stop().catch(() => {});
  }
  await ledger?.close();
  await removeStateDir(stateDir);
  await rm(backupDir, { recursive: true, force: true });
});

async function backupAndRestoreInto(targetStoreDir: string, name: string): Promise<{ server: RunningNatsServer; ctx: Ctx }> {
  // Each call gets its own snapshot directory — `nats backup stream`
  // refuses to write into one that already exists.
  const backupTargetDir = join(backupDir, `snapshot-${name}`);
  await execFileAsync(NATS_CLI_BIN, [...cliTlsArgs(), "backup", "stream", STREAM_NAME, backupTargetDir, "-s", originalServer.url, "--no-progress"]);

  const [port] = await freePorts(1);
  const server = await startNatsServer({ name, port, storeDir: targetStoreDir });
  const nc = await connectTo(server.url);
  const ctx = await makeCtx(nc);
  await execFileAsync(NATS_CLI_BIN, [...cliTlsArgs(), "backup", "restore", "stream", backupTargetDir, "-s", server.url, "--no-progress"]);
  return { server, ctx };
}

describe("S0.7 finding: Nats-Msg-Id de-dup is lost on backup/restore, and the fix", () => {
  it("resending the same Nats-Msg-Id after a restore is NOT recognised as a duplicate", async () => {
    const subject = "ev.conversation.dedup-restore-probe";
    const first = await conditionalAppend(originalCtx.js, subject, encode({ n: 1 }), {
      expectedLastSubjectSequence: 0,
      msgId: "cmd-probe-1",
    });
    expect(first.ok).toBe(true);
    expect(first.ack?.duplicate).toBe(false);
    const firstSeq = first.ack!.seq;

    // Sanity check on the SAME (not yet restored) server: the dedup window
    // does work normally here — this isolates "lost on restore" from "the
    // window just expired".
    const sameServerResend = await conditionalAppend(originalCtx.js, subject, encode({ n: 1 }), {
      expectedLastSubjectSequence: firstSeq,
      msgId: "cmd-probe-1",
    });
    expect(sameServerResend.ok).toBe(true);
    expect(sameServerResend.ack?.duplicate).toBe(true);
    expect(sameServerResend.ack?.seq).toBe(firstSeq);

    const restored = await backupAndRestoreInto(`${stateDir}/restored-1`, "t7-restored-1");
    restoredServers.push(restored);
    const restoredCtx = restored.ctx;

    // Resend the EXACT same Nats-Msg-Id, with the correct current expected
    // sequence (the message really is still at firstSeq after restore).
    const afterRestoreResend = await conditionalAppend(restoredCtx.js, subject, encode({ n: 1, retried: true }), {
      expectedLastSubjectSequence: firstSeq,
      msgId: "cmd-probe-1",
    });
    expect(afterRestoreResend.ok).toBe(true);
    // THE FINDING: this is NOT a recognised duplicate any more. The server
    // accepts it as message #2 on the subject.
    expect(afterRestoreResend.ack?.duplicate).toBe(false);
    expect(afterRestoreResend.ack?.seq).toBe(firstSeq + 1);

    const info = await restoredCtx.jsm.streams.info(STREAM_NAME, { subjects_filter: subject });
    expect(info.state.subjects?.[subject]).toBe(2);
    console.log(
      `[t7] CONFIRMED: Nats-Msg-Id de-dup survives a same-server resend (duplicate:true) but NOT a backup/restore ` +
        `(duplicate:false, subject now has ${info.state.subjects?.[subject]} messages for one logical command)`,
    );
  });

  it("a naive retry after restore creates a duplicate EFFECT; the same retry through the command ledger does not", async () => {
    const subject = "ev.conversation.hazard-demo";
    const commandId = "cmd-hazard-1";

    // First attempt, via the idempotent path, on the original server:
    // records the command in the ledger AND appends the event.
    const firstAttempt = await idempotentAppend(ledger, originalCtx, subject, encode({ action: "charge", amount: 42 }), {
      commandId,
      expectedLastSubjectSequence: 0,
    });
    expect(firstAttempt.alreadyProcessed).toBe(false);
    const firstSeq = firstAttempt.seq;

    // Restore into a SECOND fresh server (the ledger is untouched by this —
    // it is a separate PGlite instance, modelling Postgres content that is
    // backed up and restored on its own, unrelated schedule).
    const restored = await backupAndRestoreInto(`${stateDir}/restored-2`, "t7-restored-2");
    restoredServers.push(restored);
    const restoredCtx = restored.ctx;

    // --- The hazard: a naive retry that trusts Nats-Msg-Id alone ---
    // A command handler that doesn't consult a ledger, and instead follows
    // appendWithRetry's own reload-the-true-sequence-and-republish pattern
    // (the only thing this spike's retry helper does), re-reads the current
    // last sequence for the subject and republishes the SAME payload with
    // the SAME msgId. After a restore, JetStream no longer remembers this
    // msgId, so it is accepted as a genuinely new message.
    const currentSeq = (await restoredCtx.jsm.direct.getMessage(STREAM_NAME, { last_by_subj: subject }))!.seq;
    const naiveRetry = await conditionalAppend(restoredCtx.js, subject, encode({ action: "charge", amount: 42 }), {
      expectedLastSubjectSequence: currentSeq,
      msgId: commandId, // same command id as before — but dedup is gone
    });
    expect(naiveRetry.ok).toBe(true);
    expect(naiveRetry.ack?.duplicate).toBe(false);
    const infoAfterNaive = await restoredCtx.jsm.streams.info(STREAM_NAME, { subjects_filter: subject });
    expect(infoAfterNaive.state.subjects?.[subject]).toBe(2); // DUPLICATE EFFECT created
    console.log(
      `[t7] HAZARD CONFIRMED: a naive msg-id-only retry after restore produced a 2nd event for the same command ` +
        `(subject now has ${infoAfterNaive.state.subjects?.[subject]} messages for command '${commandId}')`,
    );

    // --- The fix: the SAME retry, but through idempotentAppend ---
    // A different subject, so this retry's own append (were it to happen)
    // would be clearly attributable, but the whole point is it must NOT
    // happen: the ledger already has commandId, from the first attempt on
    // the original server, and that ledger survived the "restore" (it was
    // never part of it).
    const subjectForFixDemo = "ev.conversation.hazard-demo-guarded";
    // Re-run the exact same logical command (same commandId) against the
    // restored cluster, through the guarded path this time.
    const guardedRetry = await idempotentAppend(ledger, restoredCtx, subjectForFixDemo, encode({ action: "charge", amount: 42 }), {
      commandId, // the SAME command id as firstAttempt above
      expectedLastSubjectSequence: 0,
    });
    expect(guardedRetry.alreadyProcessed).toBe(true);
    expect(guardedRetry.seq).toBe(firstSeq); // returns the ORIGINAL landing sequence, appends nothing new
    const nothingAppended = await restoredCtx.jsm.direct
      .getMessage(STREAM_NAME, { last_by_subj: subjectForFixDemo })
      .catch(() => null);
    expect(nothingAppended).toBeNull();
    console.log(
      `[t7] FIX CONFIRMED: the same retry, routed through idempotentAppend, was recognised as already-processed ` +
        `(command ledger, not Nats-Msg-Id) and appended nothing to '${subjectForFixDemo}'`,
    );
  });
});
