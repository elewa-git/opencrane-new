// Thin helpers over @nats-io/jetstream for the one layout this spike tests:
// a single stream EVENTS, subjects ev.<type>.<id>, per-subject conditional
// appends, and ordered consumers for projections.
import { jetstream, jetstreamManager, JetStreamApiError } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager, PubAck, StreamInfo } from "@nats-io/jetstream";
import { headers as natsHeaders, type NatsConnection } from "@nats-io/nats-core";

export const STREAM_NAME = "EVENTS";
export const STREAM_WRONG_LAST_SEQUENCE = 10071;

export interface Ctx {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export async function makeCtx(nc: NatsConnection): Promise<Ctx> {
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  return { nc, js, jsm };
}

export async function ensureEventsStream(
  jsm: JetStreamManager,
  opts: { replicas?: number; subjects?: string[] } = {},
): Promise<StreamInfo> {
  return await jsm.streams.add({
    name: STREAM_NAME,
    subjects: opts.subjects ?? ["ev.>"],
    storage: "file" as const,
    retention: "limits" as const,
    num_replicas: opts.replicas ?? 1,
    allow_direct: true,
  });
}

export interface AppendResult {
  ok: boolean;
  ack?: PubAck;
  /** The NATS JetStream API error code (e.g. 10071 = wrong last sequence). */
  errCode?: number;
  errMessage?: string;
}

/** A conditional append: publish is rejected unless the subject's last
 * sequence still matches `expectedLastSubjectSequence`. */
export async function conditionalAppend(
  js: JetStreamClient,
  subject: string,
  payload: Uint8Array,
  opts: { expectedLastSubjectSequence: number; msgId: string },
): Promise<AppendResult> {
  const h = natsHeaders();
  h.set("Nats-Msg-Id", opts.msgId);
  try {
    const ack = await js.publish(subject, payload, {
      expect: { lastSubjectSequence: opts.expectedLastSubjectSequence },
      headers: h,
    } as Parameters<JetStreamClient["publish"]>[2]);
    return { ok: true, ack };
  } catch (err) {
    if (err instanceof JetStreamApiError) {
      return { ok: false, errCode: err.apiError().err_code, errMessage: err.message };
    }
    // Any other failure (request timeout, no responders, connection reset)
    // is transient — typically a RAFT leader election in progress — and is
    // reported the same way as a rejection, for the caller to retry.
    return { ok: false, errMessage: err instanceof Error ? err.message : String(err) };
  }
}

export interface RetryStats {
  attempts: number;
  wrongSequenceRetries: number;
  transientRetries: number;
}

/**
 * Publishes a conditional append, retrying like a real command handler
 * would: on a wrong-last-sequence rejection it re-reads the true last
 * sequence for the subject and tries again with that; on any other error
 * (no responders, timeout, leader election in progress) it just waits a
 * beat and retries the same expectation. Gives up after `maxAttempts`.
 */
export async function appendWithRetry(
  ctx: Ctx,
  subject: string,
  payloadFn: (attempt: number) => Uint8Array,
  opts: { expectedLastSubjectSequence: number; msgId: string; maxAttempts?: number; retryDelayMs?: number },
): Promise<{ ack: PubAck; expectedUsed: number; stats: RetryStats }> {
  let expected = opts.expectedLastSubjectSequence;
  const maxAttempts = opts.maxAttempts ?? 200;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  const stats: RetryStats = { attempts: 0, wrongSequenceRetries: 0, transientRetries: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    stats.attempts++;
    const result = await conditionalAppend(ctx.js, subject, payloadFn(attempt), {
      expectedLastSubjectSequence: expected,
      msgId: opts.msgId,
    });
    if (result.ok && result.ack) {
      return { ack: result.ack, expectedUsed: expected, stats };
    }
    if (result.errCode === STREAM_WRONG_LAST_SEQUENCE) {
      stats.wrongSequenceRetries++;
      const lastMsg = await ctx.jsm.direct.getMessage(STREAM_NAME, { last_by_subj: subject }).catch(() => null);
      expected = lastMsg?.seq ?? expected;
      continue;
    }
    // Transient failure (no responders while a leader election runs, a
    // request timeout, a dropped connection mid-election, ...): wait and
    // retry the SAME expectation, since nothing has actually changed.
    stats.transientRetries++;
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`appendWithRetry: gave up after ${maxAttempts} attempts on ${subject}`);
}

export function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function decode<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}
