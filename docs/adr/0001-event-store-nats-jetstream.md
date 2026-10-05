# ADR 0001: event store — NATS JetStream

**Status:** Draft, from spike S0.7. Ready for the morning decision.
**Spike evidence:** [`spikes/s0-7-jetstream/`](../../spikes/s0-7-jetstream/), all 6 pass conditions run and passing, plus one follow-up finding (pass condition 7, below), on 2026-09-30 (darwin/arm64, nats-server v2.15.0, natscli v0.5.0, Node 22.15.0). Conditions 4 and 5 were each re-measured over 5 consecutive full-suite runs from a clean state; the ranges below are the real min–max across those 5 runs, not a single run's numbers.

Phase 1 transport and permission policy: [ADR 0005](0005-nats-access.md).
The original spike measurements below predate that policy.

## Question

Can NATS JetStream be OpenCrane 2's event store — the single, only source of
truth for every state change — as laid out in
[plan.md "Event store"](../../plan.md#open-decisions-owner) and
[docs/architecture/events.md](../architecture/events.md)? Decide before the
Phase 0 start gate (S0.1, S0.2, S0.7 must all pass).

## Options considered

| Option | Licence | Verdict |
| --- | --- | --- |
| **NATS JetStream** | Apache-2.0 (CNCF) | **Chosen** — see evidence below |
| KurrentDB | KLv1 | Ruled out before this spike: licence not acceptable for customer silos |
| PostgreSQL event store (Message DB / Emmett) | PostgreSQL / check Emmett | Fallback only, not spiked here; would need its own conditional-append, ordered-replay and dispatcher story built from scratch on top of CNPG |

## Decision

**NATS JetStream passes.** All 6 pass conditions from plan.md's Phase 0
table were run against the real official `nats-server` v2.15.0 binary (not
mocked, not Dockerised — a local process), with `@nats-io/transport-node` +
`@nats-io/jetstream` (Apache-2.0) as the client, and `@electric-sql/pglite`
(Apache-2.0) standing in for the CNPG Postgres content database so the
"projection row + checkpoint in one real transaction" property could be
proven with a real transactional SQL engine, not a fake.

| # | Pass condition | Result | Key numbers |
| --- | --- | --- | --- |
| 1 | Conditional append: concurrent writers, exactly one wins per sequence; reload-and-retry converges; `Nats-Msg-Id` de-duplication | **PASS** | 20 concurrent writers converged to 20 ordered, gap-free, duplicate-free messages; de-dup confirmed (`duplicate: true`, same seq returned); found that de-dup does **not** override a stale expected-sequence — the seq check runs first |
| 2 | Ordered replay into a projection, checkpoint in the same Postgres transaction, crash-safe | **PASS** | 500 conversation events, interleaved with correctly-sequenced noise on 3 other subjects (proving the subject filter genuinely filters). The projection loop runs as its **own OS process**, SIGKILLed **10 separate times at random points** (not a simulated crash inside the test): every kill, restart and resume from the stored checkpoint, with **zero double-apply, zero skip** (enforced by a `processed_events` primary key, not just asserted) |
| 3 | Rebuild by replay: drop projection, replay from scratch, identical result | **PASS** | 300 events, built in 5 uneven CHUNKS interleaved with more publishing and a PGlite restart between each chunk (a genuinely incremental build, not one full drain relabelled) — SHA-256 hash of the rebuilt projection == hash of the chunked incremental one, byte for byte |
| 4 | R3 failover: 3-node local cluster, kill the RAFT stream leader mid-run, keep writing, restart it | **PASS** | 1,000 subjects × 3 chained events = 3,000 conditional appends; leader killed (`SIGKILL`) at 616–720/3,000 progress; **0 lost, 0 duplicated, 0 reordered** writes, **in all 5 required consecutive full-suite runs**; write-unavailability window **≈ 4.3–5.3 s across those 5 runs** (1–124 failed heartbeat probes at a 40 ms cadence per run — sometimes many fast rejections, sometimes one slow-blocking request), **≈ 4.3–7.1 s across 10 runs total** including 5 additional solo re-runs |
| 5 | Scale: 1,000,000 distinct subjects, single node (R1) | **PASS** | 1,000,000 publishes took 36.0–142.3 s across 6 runs = **7,000–27,800 msgs/sec** (the range is this shared machine's other concurrent load during measurement, not JetStream — see the spike's README); server RSS grew ~23–34 MiB → **411–488 MiB** across those 6 runs (≈400–470 bytes/subject in memory — the PSIM per-subject index, not the tiny payload; report as a range); on-disk stream size **152–161 MiB** (≈152–161 bytes/message); conditional-append latency at 1M subjects across 6 runs: **p50 0.14–6.36 ms, p99 0.26–36.47 ms**; direct-get latency 0.22–1.36 ms; full-subject-history consumer read 3.6–61.3 ms; data deleted afterwards, every run |
| 6 | Backup and restore: official `nats` CLI snapshot/restore into a fresh server | **PASS** | 200 messages / 50 subjects backed up and restored into a brand-new server process with an empty store dir; **every single message compared byte-for-byte** (subject, stream sequence, header keys, payload bytes) in stream order, not just counts and each subject's last message; conditional appends continued to be correctly accepted/rejected after restore |
| 7 | Follow-up finding: is `Nats-Msg-Id` de-duplication durable enough to rely on for command idempotency? | **NO — finding, with a design fix** | De-dup survives a same-server resend but is **lost across a `nats backup`/`restore` cycle**: the same `Nats-Msg-Id`, resent with the correct post-restore sequence, is accepted as a brand-new message. A "naive retry" that relies only on this header (the exact pattern this spike's own `appendWithRetry` uses on a wrong-sequence rejection) then creates a **duplicate event** for the same logical command. Fix, demonstrated in the same test: a small command ledger in the content database (keyed by the command's own id, checked **before** any append) recognises the retry as already-processed and appends nothing — because that ledger is ordinary Postgres content, backed up on its own schedule, so it survives a JetStream-only restore even though JetStream's de-dup state does not |

Full detail, logs and exact commands are in the spike's
[the experiment record](../../spikes/s0-7-jetstream/README.robot.md).

### What this proves for the architecture in events.md

- **Conditional append** (`Nats-Expected-Last-Subject-Sequence`) is the
  right primitive for "one conditional append per command" — it genuinely
  serialises concurrent writers on one subject with no external locking,
  and a simple read-current-then-retry loop converges.
- **Ordered consumers checkpointed in the same Postgres transaction as the
  projection row** genuinely give crash safety: this is not a theoretical
  property of the design, it was crashed and resumed for real.
- **R3 replication** tolerates a hard leader kill with no data loss and no
  reordering — in every one of the 10 runs measured, not just once — at a
  measured **≈4.3–7.1 s write-unavailability window** during leader
  re-election — this is the range to weigh against the "always available"
  requirements elsewhere in the architecture (§ "IAM context in every
  gateway decision").
- **At least 1M entity subjects** is comfortably inside JetStream's
  envelope on a single node, with a sub-millisecond p50 append latency at
  the low (unloaded-machine) end of what was measured. The main cost is
  **not disk** (152–161 bytes/message is trivial) but **server memory for
  the per-subject index** (≈400–470 bytes/subject RSS, measured across 5
  runs) — worth tracking as a silo grows, though at silo scale (members,
  conversations, computers — thousands, not millions, of live entities)
  this is nowhere near a limit.
- **Backup/restore** via the official `nats` CLI is a real, working
  operational path, not something that has to be built.
- **`Nats-Msg-Id` de-duplication is not durable enough to be the only
  idempotency mechanism.** It is lost across a backup/restore cycle (proven
  above), and even without a restore it only lasts the duplicate window
  (2 minutes by default). Phase 1 command handlers must check their own
  command/event id against a Postgres-backed ledger **before** appending —
  the expected-sequence check alone still correctly serialises concurrent
  *different* commands on one entity stream, but does nothing to stop the
  *same* command being retried into a second event once de-dup has expired
  or been lost. See `src/idempotent-command.ts` and `tests/07-*` in the
  spike for the mechanism and the test that would fail if this were wrong.

## Consequences

- **Decision 2 in plan.md ("Event store")** is confirmed: NATS JetStream,
  Apache-2.0, is the event store for Phase 1. Whether the PostgreSQL
  fallback line in plan.md's open decisions should be removed or kept as a
  documented escape hatch is left to the owner — see open question 2
  below; this ADR does not pre-decide it.
- Phase 1's event core (typed catalogue, conditional-append command
  handlers, the projection runner with checkpoints, the dispatcher into
  pg-boss, the replay tool) can be built directly against JetStream as
  described in events.md, with the patterns in this spike's `src/` as a
  starting reference (not production code — see the spike's own README for
  what was deliberately left out).
- **Operational follow-ups for Phase 1/5, not blockers:**
  - Track per-silo server RSS against subject count as a capacity signal
    (roughly: subjects × ~450 bytes, plus baseline) rather than assuming
    memory scales with message volume.
  - The measured write-unavailability window on leader loss (see the
    range in the table above) should be folded into the "always available"
    budget-actor/decision-service design (both already run ≥2 replicas;
    the event store's own failover window is now a measured range, not a
    guess).
  - Automate the `nats backup stream` / `restore` flow into a scheduled
    job once Phase 1 stands up the real `EVENTS` stream, rather than
    leaving it as a manual CLI step.
  - Re-run pass condition 5 (scale) at whatever subject count a mature
    silo is actually expected to reach, once that number is known, to
    confirm headroom rather than re-relying on the 1M figure.
  - **Required, not optional:** every Phase 1 command handler that must
    not double-execute (anything that triggers a real-world effect) needs
    a command-ledger idempotency check as described above and demonstrated
    in `tests/07-dedup-lost-on-restore.test.ts` — do not rely on
    `Nats-Msg-Id` alone.

## Open questions for the owner

See the spike's README for the full list; the ones that matter for this
decision specifically:

1. Is the measured write-unavailability window on a killed JetStream
   leader (see the range in the pass-condition table above) acceptable,
   given the architecture's "revocation within 2 seconds" target is a
   *different* latency (OpenFGA/decision-service), not the event store's
   own failover window? Nothing in events.md currently sets a target for
   the event store's own availability during a node loss.
2. The fallback PostgreSQL event store option was not spiked (S0.7 only
   covers JetStream per plan.md's pass condition). If JetStream is
   accepted here, should the Postgres fallback line be removed from
   plan.md's open decisions, or kept dormant as a documented escape hatch?
   This ADR takes no position either way (see "Consequences" above).
