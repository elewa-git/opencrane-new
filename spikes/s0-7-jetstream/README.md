# Spike S0.7: can NATS JetStream be OpenCrane 2's event store?

One-line answer: **yes.** All 6 pass conditions from plan.md's Phase 0 table
ran against the real `nats-server` v2.15.0 binary (no Docker, no mocks) and
passed. See [the ADR draft](../../docs/adr/0001-event-store-nats-jetstream.md)
for the decision writeup; this file is the spike's own record of what was
built, run, and found.

## How to run

```bash
cd spikes/s0-7-jetstream
npm install
npm test          # runs all 6 pass-condition test files, ~35-40s total
```

Runs single-threaded, one nats-server process (or a 3-node cluster for
condition 4) per test file, each on its own free port, each cleaning up
after itself — no server is left running and no test data survives a run
(`.state/` is wiped in every file's `afterAll`, and is gitignored anyway).

Individual conditions can be run on their own:

```bash
npm run test:1   # conditional append + de-duplication
npm run test:2   # ordered replay into a projection, crash-safe
npm run test:3   # rebuild by replay
npm run test:4   # R3 failover (3-node local cluster)
npm run test:5   # scale: 1,000,000 subjects (~25s, ~150MB disk, deleted after)
npm run test:6   # backup and restore via the official `nats` CLI
```

Condition 5's subject count is overridable for a quick smoke run instead of
the full 1M, e.g. `SCALE_N=20000 npm run test:5`. The pass condition is only
genuinely met at the full 1,000,000, which is what `npm test` / `npm run
test:5` run by default.

Typecheck only: `npx tsc --noEmit`.

## Results

| # | Pass condition (plan.md / events.md) | Verdict | Evidence |
|---|---|---|---|
| 1 | Conditional append: N concurrent writers, exactly one wins per sequence, losers get the wrong-last-sequence error, reload-and-retry converges; `Nats-Msg-Id` de-duplication within the duplicate window | **PASS** | `tests/01-conditional-append.test.ts`. 20 concurrent writers racing for the first message on one subject: exactly 1 winner, 19 losers each with error code **10071** (`STREAM_WRONG_LAST_SEQUENCE`). Reload-and-retry (each loser re-reads the true last sequence via direct-get and re-publishes) converged in **20 rounds** to exactly 20 messages, strictly sequential, no gaps, no duplicates. De-dup: resending the same `Nats-Msg-Id` with the correct current sequence returns `duplicate: true` and the **same** sequence number, and the subject's message count stays at 1. |
| 2 | Ordered replay into a projection: ordered consumer filtered by subject prefix feeds a PGlite projection, projection row + consumer's last stream sequence written in ONE transaction; crash mid-stream (throw after k events), restart from the stored checkpoint; no event applied twice, none skipped | **PASS** | `tests/02-ordered-replay.test.ts`. 500 conversation events across 3 conversations, interleaved with noise on an unfiltered subject (proves the subject-prefix filter genuinely filters, not just "saw everything and got lucky"). Crashed after 137 events (closed the PGlite handle and reopened a fresh instance against the same on-disk directory — a real process restart, not a mock). Resumed from the stored checkpoint (`138`, the JetStream stream sequence, not a naive counter) and applied the remaining 363. Final count **500/500**, final projection hash-equal to an independently computed expected result. No double-apply is not just asserted: a `processed_events` table has a `PRIMARY KEY` on event id, so a re-application would have thrown inside the transaction and failed the test. |
| 3 | Rebuild by replay: drop projection tables, replay from the start, result identical (hash compare) to the incrementally built one | **PASS** | `tests/03-rebuild-by-replay.test.ts`. 300 events, built incrementally, projection hashed (SHA-256 over the full row set). Tables truncated. Replayed from stream sequence 1. Rebuilt hash **identical**, row-for-row `toEqual`. |
| 4 | R3 failover: 3-node local cluster, stream replicas 3, ~1,000 subjects with expected-last-subject-sequence writes, kill the stream leader mid-run (found via the stream-info API), keep writing, restart it; every acknowledged publish present, per-subject order intact, no duplicates; measure the write-unavailability window | **PASS** | `tests/04-r3-failover.test.ts`. 3 real `nats-server` processes (separate store dirs, separate ports, real cluster routes), stream `num_replicas: 3`. 1,000 subjects × 3 chained conditional appends = 3,000 total, spread across 30 concurrent writer lanes. Leader (found via `StreamInfo.cluster.leader`) killed with `SIGKILL` at **1,091–1,205/3,000** progress across 3 separate runs. Writers kept retrying through the election (their own `appendWithRetry` reload-on-wrong-sequence / wait-and-retry-on-transient-error loop) and all 3,000 eventually landed. Read-back after restart: **3,000/3,000 present, every one of the 1,000 subjects' 3 events in strict order (n=0,1,2), zero duplicates, zero out-of-order subjects.** Measured write-unavailability window (dedicated heartbeat prober at a 40ms cadence): **≈ 4.6–6.0 s** across runs (106–140 failed probe attempts). |
| 5 | Scale: 1,000,000 distinct subjects, tiny payloads, single node (R1); publish throughput, server RSS, disk, latency of an expected-last-subject-sequence publish at 1M subjects, latency to read one subject's full history; delete afterwards | **PASS** | `tests/05-scale-1m.test.ts`. 1,000,000 publishes in **22.6–25.5s** → **39,000–44,000 msgs/sec** (concurrency-256 pipeline of real JetStream-acknowledged publishes, not fire-and-forget). Server RSS: **~22–42 MiB → ~408–423 MiB** over the run. On-disk stream size: **152 MiB** for 1,000,100 messages across 1,000,000 subjects (≈152 bytes/message). Conditional-append latency once all 1M subjects exist: **p50 ≈ 0.14–0.18 ms, p99 ≈ 8.6–10.8 ms** (30 samples). Direct-get (last message for a subject) latency: **≈ 0.2–0.3 ms**. Full-history read of one subject (6 messages, via a filtered consumer): **≈ 5.7–6.0 ms**. Data deleted in `afterAll`; confirmed via `df -h /` before/after (no net change from this test) and `du -sh .state` (0B after). |
| 6 | Backup and restore: snapshot the stream (official `nats` CLI, Apache-2.0), restore into a fresh server, verify all messages and per-subject last sequences match, expected-sequence appends continue correctly after restore | **PASS** | `tests/06-backup-restore.test.ts`. 200 messages / 50 subjects, 4 chained appends each. `nats backup stream EVENTS <dir>` then `nats backup restore stream <dir>` into a **brand-new** server process (fresh, empty store directory — confirmed the stream didn't already exist there before restore). Restored stream: **200/200 messages, 26 KiB, byte-identical** message count and size to the original. Every one of the 50 subjects' last stream sequence matched exactly, and its payload matched. A correct-sequence append after restore was accepted; a stale-sequence append was correctly rejected with **10071** — proving the restored stream's per-subject sequence *state*, not just its messages, survived. |

All 6 test files / 7 tests pass together in one `npm test` run (~38s), each
cleaning up its own server process(es) and on-disk state; verified with
`ps aux | grep nats-server` (empty after every run) and `du -sh .state`
(0B after every run).

### How per-subject ordering + a durable consumer feed a per-stream-ordered dispatcher

Not separately spiked as its own test (it's a composition of conditions 2
and 4, not a new mechanism), but worth stating plainly since events.md
depends on it: a **durable** consumer (as opposed to the **ordered**
consumers used in conditions 2/3, which are ephemeral and client-tracked)
filtered on `ev.>` would feed the dispatcher described in events.md. Because
JetStream guarantees strict per-subject order and the durable consumer
delivers in stream order, the dispatcher can enqueue each event into a
pg-boss `key_strict_fifo` queue keyed by subject (= stream = conversation,
budget, etc.) and get "one writer at a time per stream" for free from the
event store's own ordering — the dispatcher's job is just to *preserve*
that order into the queue key, not to *create* it. This spike's condition 4
demonstrates the underlying guarantee this depends on (strict per-subject
order survives a leader failover); a small follow-up spike or Phase 1 slice
would demonstrate the dispatcher itself end-to-end with pg-boss.

## Findings and surprises

- **De-dup does not override a mismatched expected-sequence.** Resending
  the same `Nats-Msg-Id` with a *stale* expected sequence is rejected with
  the sequence-mismatch error (10071), not silently deduplicated. The
  sequence check runs before the msg-id check. A retrying command handler
  must use the sequence its *own* earlier attempt actually landed at (or
  re-read the true current sequence), not just blindly resend with the
  same original expectation.
- **Naive reload-and-retry converges, but in O(N) rounds under heavy
  contention**, because every pending writer reads the same "current last
  sequence" and all-but-one lose each round (20 writers → 20 rounds in
  condition 1). Real command handlers contending hard on one entity
  stream (unlikely for a per-conversation or per-computer stream, but
  worth naming) would benefit from jitter/backoff on retry, or from the
  natural spread that comes from different commands landing at different
  times in practice.
- **Memory, not disk, is the real cost of many subjects.** 1M subjects
  cost only 152 MiB on disk but ~400 MiB of server RSS — a ~420
  bytes/subject in-memory cost (JetStream's per-subject index, sometimes
  called PSIM). At OpenCrane 2 silo scale (members, conversations,
  computers — thousands of live entity streams, not millions), this is
  nowhere near a problem, but it's the number to watch if a silo design
  ever pushes into "one entity subject per message" territory instead of
  "one entity subject per long-lived thing".
- **Append latency has a long tail even on an idle single node at 1M
  subjects** (p50 ~0.15ms but p99 up to ~10ms in a 30-sample probe). This
  is plausibly GC/background-sync jitter in a freshly-loaded in-memory
  index rather than a fundamental JetStream limit; it's worth re-measuring
  with a larger sample and under sustained load before treating either
  number as a committed SLO.
- **The R3 write-unavailability window (~5–6s) is a real, measured cost of
  hard leader loss**, not a guess. It varied 4.6s–6.0s across 3 runs of the
  same test on the same machine — consistent with RAFT election timing
  variance rather than a bug. Nothing in events.md currently sets a
  target for this specific window (the "revocation within 2 seconds"
  target is a different thing: OpenFGA/decision-service revocation
  latency, not event-store availability during a node loss) — see the
  open question below.
- **Backup/restore via the official `nats` CLI just works** and is fast at
  small scale (instant for 200 messages); it was not re-tested at the 1M
  scale (condition 6 uses its own small, independent fixture — see
  "Deviations" below for why) so backup/restore timing at large N is not
  yet known.
- **`natscli`'s versioning has been decoupled from `nats-server`'s**: the
  latest stable natscli is `v0.5.0`, not a `v2.x` matching the server. This
  is normal (confirmed via the GitHub API: not a draft, not a prerelease)
  and not a sign of anything stale — just a naming-scheme note for whoever
  next has to "get the latest CLI".

## Deviations from the brief

- **Condition 6 (backup/restore) uses its own smaller fixture (50
  subjects, 200 messages)** rather than reusing the 1,000,000-subject
  dataset from condition 5. Each test file's `afterAll` deletes its own
  data, so there is no persistent 1M-subject stream lying around for
  condition 6 to snapshot without re-paying the ~25s/150MB cost of
  recreating it. Backup/restore *mechanics and correctness* are fully
  proven at the smaller scale; backup/restore *timing at 1M subjects* is
  therefore **NOT RUN**, not asserted as passing — see open questions.
- **Condition 4 runs 1,000 subjects × 3 events (3,000 total appends)**
  rather than a larger number — the brief says "across ~1,000 subjects",
  which this matches; the chain length of 3 (not more) was chosen to keep
  the run fast and repeatable while still proving per-subject order across
  multiple appends per subject, not just single-shot writes.
- **The write-unavailability window in condition 4 is measured with a
  dedicated heartbeat prober** (its own subject, its own sequence,
  `maxAttempts: 1` so every individual failure is visible) run concurrently
  with the bulk writers, rather than inferred from the bulk writers'
  aggregate retry behaviour, which would conflate real downtime with the
  bulk writers' own retry backoff delay.
- **No code here is meant to be reused as-is in Phase 1.** This is spike
  code: no production error taxonomy, no observability, no config
  surface, deliberately minimal. Phase 1's actual event core should be
  designed fresh from events.md, using this spike's measured facts (the
  API shapes that exist, the error codes, the latency/memory numbers) as
  input, not by copying these files.

## Open questions for the owner

1. **Is a ~5–6s write-unavailability window on a killed JetStream leader
   acceptable?** events.md doesn't currently set a target for this. If
   not, the mitigation is operational (faster election timeouts, or
   accepting it as a rare-failure cost) rather than architectural — R3
   itself already prevented any data loss or reordering.
2. **Should the PostgreSQL event-store fallback be removed from plan.md's
   open decisions**, now that JetStream has passed all 6 conditions? It
   was not spiked here (plan.md's S0.7 pass condition only covers
   JetStream) and keeping it "documented but dormant" vs. removing it
   outright is a plan.md edit outside this spike's remit.
3. **Backup/restore timing at large (1M-subject) scale is unknown** — do
   we need that number before Phase 5's "backup/restore of Postgres,
   Cognee and snapshots together" qualification work, or is small-scale
   correctness (proven here) sufficient for the Phase 0 gate and large-
   scale timing can be measured later against a real silo's actual size?
4. **The p99 append-latency tail (~9-11ms) at 1M subjects** was measured
   with only 30 samples on an otherwise-idle machine. Worth a larger,
   more controlled benchmark (more samples, concurrent read/write load)
   before it's used in any capacity planning, rather than trusting this
   spike's number as precise.

## What's in this folder

```
src/
  nats-proc.ts     spawn/stop real nats-server processes (single node or clustered)
  jetstream.ts     conditionalAppend, appendWithRetry, stream/consumer helpers
  projection.ts    PGlite-backed projection + checkpoint, one transaction per event
  pool.ts          tiny concurrency-limited worker pool (no external dep)
  measure.ts       RSS/disk sampling helpers (ps / du)
  ports.ts         free TCP port allocation
  hash.ts          SHA-256 of a JSON value, for rebuild-equality checks
tests/
  01-conditional-append.test.ts
  02-ordered-replay.test.ts
  03-rebuild-by-replay.test.ts
  04-r3-failover.test.ts
  05-scale-1m.test.ts
  06-backup-restore.test.ts
.tools/            official release binaries (gitignored; see table below)
.state/            per-test-run server data and PGlite directories (gitignored, wiped after every run)
```

## Downloaded binaries and dependencies

Official GitHub release binaries, latest stable (non-RC, non-draft) for
darwin/arm64, downloaded into `.tools/` (gitignored):

| Name | Version | URL | Size | Licence |
|---|---|---|---|---|
| nats-server | v2.15.0 | https://github.com/nats-io/nats-server/releases/download/v2.15.0/nats-server-v2.15.0-darwin-arm64.tar.gz | 6.7 MB download / 17.5 MB extracted binary | Apache-2.0 |
| nats (natscli) | v0.5.0 | https://github.com/nats-io/natscli/releases/download/v0.5.0/nats-0.5.0-darwin-arm64.zip | 9.4 MB download / 26.1 MB extracted binary | Apache-2.0 |

npm packages (all OSI-approved licences, checked via `npm view <pkg>
license` before adding):

| Name | Version | Licence |
|---|---|---|
| @nats-io/transport-node | 3.4.0 | Apache-2.0 |
| @nats-io/jetstream | 3.4.0 | Apache-2.0 |
| @nats-io/nats-core | 3.4.0 (transitive) | Apache-2.0 |
| @nats-io/nkeys | transitive | Apache-2.0 |
| @nats-io/nuid | transitive | Apache-2.0 |
| @electric-sql/pglite | 0.5.8 | Apache-2.0 |
| typescript | 7.0.2 (dev) | Apache-2.0 |
| vitest | 5.0.3 (dev) | MIT |
| @types/node | 26.6.3 (dev) | MIT |

## Disk footprint

- `node_modules/`: 94 MB
- `.tools/`: 42 MB
- `.state/`: 0 B at rest (each test file creates and then deletes its own;
  peak during condition 5 was ≈152 MB for the 1M-subject stream, deleted
  in that file's `afterAll`)
- **Total resting footprint: ≈136 MB**, well under the 1.5 GB budget.
  Peak transient footprint during a full `npm test` run (while condition 5
  is at its largest) is ≈290 MB (136 MB resting + ≈152 MB transient
  stream data), also comfortably under budget.

## Environment this was run on

- macOS (darwin/arm64), Node v22.15.0
- nats-server v2.15.0, natscli v0.5.0 (both official release binaries)
- No Docker, no Kubernetes, no cloud calls, no secrets — local processes
  only, as required
