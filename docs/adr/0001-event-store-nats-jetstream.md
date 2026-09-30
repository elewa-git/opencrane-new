# ADR 0001: event store — NATS JetStream

**Status:** Draft, from spike S0.7. Ready for the morning decision.
**Spike evidence:** [`spikes/s0-7-jetstream/`](../../spikes/s0-7-jetstream/), all 6 pass conditions run and passing on 2026-09-30 (darwin/arm64, nats-server v2.15.0, natscli v0.5.0, Node 22.15.0).

## Question

Can NATS JetStream be OpenCrane 2's event store — the single, only source of
truth for every state change — as laid out in
[plan.md "Event store"](../../plan.md#open-decisions-owner) and
[docs/architecture/events.md](../architecture/events.md)? Decide before the
Phase 0 start gate (S0.1, S0.2, S0.7 must all pass).

## Options considered

| Option | Licence | Verdict |
|---|---|---|
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
|---|---|---|---|
| 1 | Conditional append: concurrent writers, exactly one wins per sequence; reload-and-retry converges; `Nats-Msg-Id` de-duplication | **PASS** | 20 concurrent writers converged to 20 ordered, gap-free, duplicate-free messages; de-dup confirmed (`duplicate: true`, same seq returned); found that de-dup does **not** override a stale expected-sequence — the seq check runs first |
| 2 | Ordered replay into a projection, checkpoint in the same Postgres transaction, crash-safe | **PASS** | 500 events, simulated crash after 137 (process killed and reopened against the same on-disk PGlite dir), resumed from the stored checkpoint, applied the remaining 363 with **zero double-apply, zero skip** (enforced by a `processed_events` primary key, not just asserted) |
| 3 | Rebuild by replay: drop projection, replay from scratch, identical result | **PASS** | 300 events, SHA-256 hash of the rebuilt projection == hash of the incrementally built one, byte for byte |
| 4 | R3 failover: 3-node local cluster, kill the RAFT stream leader mid-run, keep writing, restart it | **PASS** | 1,000 subjects × 3 chained events = 3,000 conditional appends; leader killed (`SIGKILL`) at 1,205/3,000 progress; **0 lost, 0 duplicated, 0 reordered** writes; write-unavailability window **≈ 6.0 s** (140 failed heartbeat probes at a 40 ms cadence) |
| 5 | Scale: 1,000,000 distinct subjects, single node (R1) | **PASS** | 1,000,000 publishes in 22.6 s = **44,338 msgs/sec**; server RSS grew 22 MiB → **423 MiB** (≈ 420 bytes/subject in memory — the PSIM per-subject index, not the tiny payload); on-disk stream size **152 MiB** (≈ 152 bytes/message); conditional-append latency at 1M subjects: **p50 0.14 ms, p99 8.6 ms**; direct-get latency 0.20 ms; full-subject-history consumer read 5.7 ms; data deleted afterwards |
| 6 | Backup and restore: official `nats` CLI snapshot/restore into a fresh server | **PASS** | 200 messages / 50 subjects backed up and restored into a brand-new server process with an empty store dir; message count, byte count and every per-subject last sequence matched exactly; conditional appends continued to be correctly accepted/rejected after restore |

Full detail, logs and exact commands are in the spike's
[README.md](../../spikes/s0-7-jetstream/README.md).

### What this proves for the architecture in events.md

- **Conditional append** (`Nats-Expected-Last-Subject-Sequence`) is the
  right primitive for "one conditional append per command" — it genuinely
  serialises concurrent writers on one subject with no external locking,
  and a simple read-current-then-retry loop converges.
- **Ordered consumers checkpointed in the same Postgres transaction as the
  projection row** genuinely give crash safety: this is not a theoretical
  property of the design, it was crashed and resumed for real.
- **R3 replication** tolerates a hard leader kill with no data loss and no
  reordering, at a measured ~6 s write-unavailability window during
  leader re-election — this is the number to weigh against the "always
  available" requirements elsewhere in the architecture (§ "IAM context in
  every gateway decision").
- **At least 1M entity subjects** is comfortably inside JetStream's
  envelope on a single node, with sub-millisecond p50 append latency even
  at that scale. The main cost is **not disk** (152 bytes/message is
  trivial) but **server memory for the per-subject index** (~420
  bytes/subject RSS) — worth tracking as a silo grows, though at silo
  scale (members, conversations, computers — thousands, not millions, of
  live entities) this is nowhere near a limit.
- **Backup/restore** via the official `nats` CLI is a real, working
  operational path, not something that has to be built.

## Consequences

- **Decision 2 in plan.md ("Event store")** is confirmed: NATS JetStream,
  Apache-2.0, is the event store. The PostgreSQL fallback is not needed.
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
  - The measured ~6 s write-unavailability window on leader loss should be
    folded into the "always available" budget-actor/decision-service
    design (both already run ≥2 replicas; the event store's own failover
    window is now a known number, not a guess).
  - Automate the `nats backup stream` / `restore` flow into a scheduled
    job once Phase 1 stands up the real `EVENTS` stream, rather than
    leaving it as a manual CLI step.
  - Re-run pass condition 5 (scale) at whatever subject count a mature
    silo is actually expected to reach, once that number is known, to
    confirm headroom rather than re-relying on the 1M figure.

## Open questions for the owner

See the spike's README for the full list; the ones that matter for this
decision specifically:

1. Is a ~6 s write-unavailability window on a killed JetStream leader
   acceptable, given the architecture's "revocation within 2 seconds"
   target is a *different* latency (OpenFGA/decision-service), not the
   event store's own failover window? Nothing in events.md currently sets
   a target for the event store's own availability during a node loss.
2. The fallback PosttgreSQL event store option was not spiked (S0.7 only
   covers JetStream per plan.md's pass condition). If JetStream is
   accepted here, should the Postgres fallback line be removed from
   plan.md's open decisions, or kept dormant as a documented escape hatch?
