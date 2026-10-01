// The design fix for a hazard this spike found: JetStream's own
// `Nats-Msg-Id` de-duplication is NOT durable across a `nats backup` /
// `restore` cycle (proven in tests/07), and even without a restore it only
// lasts the duplicate window (a couple of minutes by default). So it must
// never be the ONLY thing standing between a retried command and a
// duplicate effect (an agent taking the same real-world action twice, a
// payment recorded twice, and so on).
//
// The fix: keep a small table in the CONTENT database (PGlite standing in
// for CNPG here) of "commands already turned into an event", keyed by the
// command's own id (the same id used as `Nats-Msg-Id`) — consulted BEFORE
// any append is attempted. This table is ordinary PostgreSQL content, so
// it is backed up and restored on its own normal schedule, independently
// of the event store; it survives a JetStream restore even though
// JetStream's own de-dup state does not.
//
// The expected-sequence check (`Nats-Expected-Last-Subject-Sequence`)
// still does its job alongside this: it is what serialises two DIFFERENT
// commands racing for the same entity stream. This ledger is what stops
// the SAME command being turned into a second event.
//
// Rule for OpenCrane's real command handlers (Phase 1): never treat a
// successful `conditionalAppend` as the only proof a command ran. Check
// the command's own id against this kind of table first; only append if
// it is not already there; record it in the SAME Postgres transaction a
// real handler would use to write anything else. Do not rely on
// `Nats-Msg-Id` for correctness — treat it as a nice-to-have that softens
// a narrow race, not as the idempotency mechanism.
import { PGlite } from "@electric-sql/pglite";
import { conditionalAppend, type Ctx } from "./jetstream.ts";

export async function openCommandLedger(dataDir: string): Promise<PGlite> {
  const db = new PGlite(dataDir);
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS processed_commands (
      command_id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      stream_seq BIGINT NOT NULL
    );
  `);
  return db;
}

export interface IdempotentAppendResult {
  /** True if this command id was already in the ledger — nothing was
   * appended, and `seq` is the sequence its EARLIER attempt landed at. */
  alreadyProcessed: boolean;
  seq: number;
}

/**
 * Appends a command's event, unless this exact command id has already been
 * turned into one — checked against the command ledger (Postgres content),
 * not against JetStream's own short-lived, restore-losable `Nats-Msg-Id`
 * de-duplication.
 */
export async function idempotentAppend(
  ledger: PGlite,
  ctx: Ctx,
  subject: string,
  payload: Uint8Array,
  opts: { commandId: string; expectedLastSubjectSequence: number },
): Promise<IdempotentAppendResult> {
  const existing = await ledger.query<{ stream_seq: string }>(
    `SELECT stream_seq FROM processed_commands WHERE command_id = $1`,
    [opts.commandId],
  );
  if (existing.rows.length > 0) {
    return { alreadyProcessed: true, seq: Number(existing.rows[0].stream_seq) };
  }

  const res = await conditionalAppend(ctx.js, subject, payload, {
    expectedLastSubjectSequence: opts.expectedLastSubjectSequence,
    msgId: opts.commandId,
  });
  if (!res.ok || !res.ack) {
    throw new Error(`idempotentAppend failed: ${res.errMessage}`);
  }
  await ledger.query(
    `INSERT INTO processed_commands (command_id, subject, stream_seq) VALUES ($1, $2, $3)
     ON CONFLICT (command_id) DO NOTHING`,
    [opts.commandId, subject, res.ack.seq],
  );
  return { alreadyProcessed: false, seq: res.ack.seq };
}
