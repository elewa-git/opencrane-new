# Spike S0.7: can NATS JetStream be OpenCrane 2's event store?

One-line answer: **yes.** All 6 pass conditions from plan.md's Phase 0 table
ran against the real `nats-server` v2.15.0 binary (no Docker, no mocks) and
passed — verified over 5 consecutive full-suite runs from a clean state, not
just once. A 7th test, added during review, found and fixed a real gap
(`Nats-Msg-Id` de-duplication does not survive a backup/restore). See
[the ADR draft](../../docs/adr/0001-event-store-nats-jetstream.md) for the
decision writeup; this file is the spike's own record of what was built,
run, and found.

## How to run

```bash
cd spikes/s0-7-jetstream
npm install
npm test          # runs all 6 pass-condition test files + 1 follow-up finding, ~60-240s total (varies with machine load)
```

Runs single-threaded, one nats-server process (or a 3-node cluster for
condition 4) per test file, each on its own free port, each cleaning up
after itself — no server is left running and no test data survives a run
(`.state/` is wiped in every file's `afterAll`, and is gitignored anyway).

Individual conditions can be run on their own:

```bash
npm run test:1   # conditional append + de-duplication
npm run test:2   # ordered replay into a projection, REAL crash-safe (child process, SIGKILL)
npm run test:3   # rebuild by replay (chunked incremental vs. full rebuild)
npm run test:4   # R3 failover (3-node local cluster)
npm run test:5   # scale: 1,000,000 subjects (~25-150s depending on machine load, ~150MB disk, deleted after)
npm run test:6   # backup and restore via the official `nats` CLI (every message compared)
npm run test:7   # finding: Nats-Msg-Id de-dup lost on restore, and the idempotent-ledger fix
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
| 2 | Ordered replay into a projection: ordered consumer filtered by subject prefix feeds a PGlite projection, projection row + consumer's last stream sequence written in ONE transaction; a REAL crash mid-stream, restart from the stored checkpoint; no event applied twice, none skipped | **PASS** | `tests/02-ordered-replay.test.ts`. The projection loop runs as its **own OS process** (`src/projection-worker.ts`, spawned with `node --experimental-strip-types`) — the test sends it real `SIGKILL`s, not a simulated crash inside the test's own process. 500 conversation events across 3 conversations, interleaved with noise on **3** other subjects, each tracked with its own correctly-incrementing expected sequence (not a hard-coded 0 — that would make every noise publish after the first on a subject fail silently and land only 1 of 250). Killed **10 separate times, at random points** (50–400ms after each restart reports ready), while publishing continues concurrently. Every kill/restart resumed from the stored checkpoint. Final count **500/500 applied, 0 skipped, 0 double-applied** (a `processed_events` table has a `PRIMARY KEY` on event id — a re-application under any kill timing would have thrown inside the transaction and failed the test), final projection hash-equal to an independently computed expected result. |
| 3 | Rebuild by replay: drop projection tables, replay from the start, result identical (hash compare) to the incrementally built one | **PASS** | `tests/03-rebuild-by-replay.test.ts`. 300 events, built the "incremental" side in **5 uneven chunks (37+61+53+79+70)**, publishing more events between chunks and closing + reopening PGlite between chunks (a real restart, resuming from the stored checkpoint each time) — a genuinely incremental build, not one continuous drain relabelled. Hashed (SHA-256 over the full row set). Tables truncated. Replayed from stream sequence 1 in **one single full drain** — the actual "rebuild" operation. Rebuilt hash **identical**, row-for-row `toEqual`. |
| 4 | R3 failover: 3-node local cluster, stream replicas 3, ~1,000 subjects with expected-last-subject-sequence writes, kill the stream leader mid-run (found via the stream-info API), keep writing, restart it; every acknowledged publish present, per-subject order intact, no duplicates; measure the write-unavailability window | **PASS** | `tests/04-r3-failover.test.ts`. 3 real `nats-server` processes (separate store dirs, separate ports, real cluster routes), stream `num_replicas: 3`. 1,000 subjects × 3 chained conditional appends = 3,000 total, spread across 30 concurrent writer lanes. Leader (found via `StreamInfo.cluster.leader`) killed with `SIGKILL` at **616–720/3,000** progress. Writers kept retrying through the election (their own `appendWithRetry` reload-on-wrong-sequence / wait-and-retry-on-transient-error loop) and all 3,000 eventually landed, in every one of **5 consecutive full-suite runs from a clean state** (see "Re-run" note below). Read-back after restart: **3,000/3,000 present, every one of the 1,000 subjects' 3 events in strict order (n=0,1,2), zero duplicates, zero out-of-order subjects — in all 5 runs.** Measured write-unavailability window (dedicated heartbeat prober at a 40ms cadence): **≈ 4.3–5.3 s across the 5 required runs** (1–124 failed probe attempts per run — sometimes many fast rejections, sometimes one request that blocks for most of the window before failing); **≈ 4.3–7.1 s across 10 runs total** including 5 additional solo re-runs made while fixing the setup flake below. |
| 5 | Scale: 1,000,000 distinct subjects, tiny payloads, single node (R1); publish throughput, server RSS, disk, latency of an expected-last-subject-sequence publish at 1M subjects, latency to read one subject's full history; delete afterwards | **PASS** | `tests/05-scale-1m.test.ts`. 1,000,000 publishes across 6 full-suite runs took **36.0–142.3s** → **7,000–27,800 msgs/sec** (concurrency-256 pipeline of real JetStream-acknowledged publishes, not fire-and-forget; the wide range is this shared machine's other concurrent load during measurement, not JetStream itself — see "Re-run" note). Server RSS: **~23–34 MiB → ~411–488 MiB** across the 6 runs. On-disk stream size: **152–161 MiB** for ~1,000,100 messages across 1,000,000 subjects (≈152–161 bytes/message). Conditional-append latency once all 1M subjects exist: **p50 0.14–6.36 ms, p99 0.26–36.47 ms** (30 samples/run; the low end, ~0.14/0.26ms, is what an unloaded machine gives). Direct-get (last message for a subject) latency: **0.22–1.36 ms**. Full-history read of one subject (6 messages, via a filtered consumer): **3.6–61.3 ms**. Data deleted in `afterAll` every run; confirmed via `df -h /` before/after (no net change) and `du -sh .state` (0B after) — in all 6 runs. |
| 6 | Backup and restore: snapshot the stream (official `nats` CLI, Apache-2.0), restore into a fresh server, verify all messages and per-subject last sequences match, expected-sequence appends continue correctly after restore | **PASS** | `tests/06-backup-restore.test.ts`. 200 messages / 50 subjects, 4 chained appends each. `nats backup stream EVENTS <dir>` then `nats backup restore stream <dir>` into a **brand-new** server process (fresh, empty store directory — confirmed the stream didn't already exist there before restore). Restored stream: **200/200 messages, 26 KiB, byte-identical** message count and size to the original. **Every single one of the 200 messages compared, in stream order** (subject, stream sequence, header keys, exact payload bytes) — not just counts and each subject's last message. 0 mismatches. A correct-sequence append after restore was accepted; a stale-sequence append was correctly rejected with **10071** — proving the restored stream's per-subject sequence *state*, not just its messages, survived. |
| 7 | *(new finding, not in the original plan.md table)* Is `Nats-Msg-Id` de-duplication durable enough to be the only idempotency mechanism for a command handler? | **NO — with a demonstrated fix** | `tests/07-dedup-lost-on-restore.test.ts`. Confirms de-dup survives a same-server resend (`duplicate: true`) but is **lost across backup/restore**: the identical `Nats-Msg-Id`, resent with the correct post-restore expected sequence, is accepted as message #2 (`duplicate: false`). Then shows the real hazard: a "naive retry" using exactly the pattern this spike's own `appendWithRetry` uses (re-read the true sequence, republish the same `Nats-Msg-Id`) creates a **second, duplicate event** for the same logical command after a restore. Finally shows the fix: the same retry routed through `idempotentAppend` (`src/idempotent-command.ts`), backed by a small command ledger that lives in the content database (never touched by the JetStream restore, exactly as real Postgres content wouldn't be), is recognised as already-processed and appends **nothing**. |

All 7 test files / 9 tests pass together in one `npm test` run
(~60–240s, depending heavily on how much else is running on the same
machine — see below), each cleaning up its own server process(es),
worker process(es) and on-disk state; verified with `ps aux | grep -E
"nats-server|projection-worker"` (empty after every run) and `du -sh
.state` (0B after every run). **Re-run 5 times in a row from a clean
state, plus one further confirmatory run** (the flaky condition-4 setup
below was the reason for this): all 6 full-suite runs passed,
`Test Files 7 passed (7)`, `Tests 9 passed (9)`, with total run time
ranging 61s–237s under varying concurrent machine load
from other, unrelated processes (this machine was shared with other
agent sessions during these runs; none of that affects correctness, only
wall-clock time and the throughput/latency numbers below).

### Re-run: 5 consecutive full-suite runs from a clean state

A previous round of this spike had a **flaky one-command run**: `tests/04-r3-failover.test.ts`'s `beforeAll` called `makeCtx` (which calls `jetstreamManager`, which calls `getAccountInfo`) once, *before* the retry loop that waits for the cluster's meta leader to be elected — so on a slow start, that first call could throw `TimeoutError` and fail the whole test file before the retry loop ever ran. Fixed by moving `makeCtx` **inside** the retry loop (`tests/04-r3-failover.test.ts`), so the whole "get a JetStream context, then create the replicated stream" sequence retries together.

To prove the fix, `npm test` was run **5 times in a row from a clean state** (`.state/` wiped, no leftover processes, fresh `npm ci`) — the required evidence — plus `npm run test:4` alone another 5 times, plus one more full-suite run after a couple of trivial dead-code cleanups (an unused variable and an unused type import; confirmed behaviour-neutral by `tsc --noEmit` and included here for completeness, since it is the literal final code). **All 11 runs passed with no setup flake:**

| Run | Result | Duration | t5 bulk-load throughput | t5 RSS max | t4 window |
|---|---|---|---|---|---|
| Full suite 1 | ✅ 7 files / 9 tests | 109.4s | 18,897 msgs/s | 448.9 MiB | 4,284 ms |
| Full suite 2 | ✅ 7 files / 9 tests | 79.2s | 22,837 msgs/s | 436.6 MiB | 4,875 ms |
| Full suite 3 | ✅ 7 files / 9 tests | 236.6s | 7,027 msgs/s | 442.3 MiB | 5,046 ms |
| Full suite 4 | ✅ 7 files / 9 tests | 129.1s | 10,635 msgs/s | 488.0 MiB | 5,288 ms |
| Full suite 5 | ✅ 7 files / 9 tests | 97.6s | 15,289 msgs/s | 410.7 MiB | 5,042 ms |
| Full suite 6 (confirmatory, final code) | ✅ 7 files / 9 tests | 61.3s | 27,771 msgs/s | 429.0 MiB | 5,841 ms |
| `test:4` solo ×5 | ✅✅✅✅✅ | 5.4–11.7s each | — | — | 4,517 / 4,551 / 5,262 / 5,630 / 7,087 ms |

The duration and throughput swing a lot (61s–237s; 7,000–27,800 msgs/sec)
because this development machine was **shared with several other,
unrelated agent sessions** running their own test suites concurrently
throughout this work (visible in `ps aux` — other `vitest`/`nats-server`
processes came and went during these runs; `ListAgents` confirmed 2 peer
sessions active). That is genuine concurrent CPU/disk contention, not
JetStream instability: every correctness assertion (exactly-once winners,
zero lost/duplicated/reordered writes, zero double-applied events,
byte-identical restore) passed in **all 11 runs**, and cleanup (`ps aux`
empty, `.state` 0B, no net disk change) was verified after each one. The
RSS and failover-window **ranges** reported in the table above are the
honest min–max across these real runs, not a single cherry-picked number.

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
  cost only ~152–161 MiB on disk but ~411–488 MiB of server RSS across 5
  measured runs — roughly 400–470 bytes/subject in-memory cost (JetStream's
  per-subject index, sometimes called PSIM; report this as a range, not a
  single figure, when it feeds capacity planning). At OpenCrane 2 silo
  scale (members, conversations, computers — thousands of live entity
  streams, not millions), this is nowhere near a problem, but it's the
  number to watch if a silo design ever pushes into "one entity subject
  per message" territory instead of "one entity subject per long-lived
  thing".
- **Append latency has a long tail, and it is dominated by machine load,
  not JetStream.** Across 5 runs: p50 0.14–6.36ms, p99 0.26–36.47ms
  (30-sample probe each). The low end (~0.14/0.26ms) is what an unloaded
  machine gives; the high end coincides with other, unrelated processes
  competing for CPU on this shared development machine during that run.
  Worth re-measuring with a larger sample on a dedicated/idle machine
  before treating either end as a committed SLO.
- **The R3 write-unavailability window is a real, measured cost of hard
  leader loss**, not a guess, but it needs a RANGE, not a single number:
  **≈4.3–5.3s across the 5 required consecutive full-suite runs, ≈4.3–7.1s
  across 10 runs total** (5 of those solo, while verifying the fix for the
  setup flake below) — consistent with RAFT election timing variance
  rather than a bug. The failed-probe-attempt *count* varies a lot more
  than the window itself (1 to 124): sometimes the window is many fast
  (sub-10ms) rejections back-to-back, other times it's a single request
  that blocks for nearly the whole window before failing — both are real,
  neither is a bug. Nothing in events.md currently sets a target for this
  specific window (the "revocation within 2 seconds" target is a
  different thing: OpenFGA/decision-service revocation latency, not
  event-store availability during a node loss) — see the open question
  below.
- **A previously-flaky one-command run is now fixed and proven stable.**
  `tests/04-r3-failover.test.ts`'s `beforeAll` used to call `makeCtx`
  (→ `jetstreamManager` → `getAccountInfo`) once, before the retry loop
  that waits for the cluster to elect a metadata leader — so on a slow
  start it could throw before the retry loop ever ran. Fixed by moving
  `makeCtx` inside that retry loop. Verified with **5 consecutive full
  `npm test` runs from a clean state, plus 5 solo `npm run test:4` runs**
  — 10/10 green, see "Re-run" above.
- **A simulated crash (close-and-reopen inside the test process) is not
  the same test as a real one.** The previous version of condition 2's
  test "crashed" by breaking its own loop and calling `db.close()` in an
  orderly way — no process was ever actually killed. Rewritten so the
  projection loop runs as its own OS process (`src/projection-worker.ts`)
  and the test sends it real `SIGKILL`s (10 per run, at random points).
  The property (no double-apply, no skip) held under all of them, but the
  distinction matters: a graceful `.close()` gets to finish whatever it
  was doing; `SIGKILL` doesn't, and that's the case that actually needed
  proving.
- **An "incremental build" that is really just the rebuild run twice
  proves much less than it looks like.** The previous version of
  condition 3 built its "incremental" projection with one continuous
  drain from sequence 1, after all 300 events were already published —
  which is the exact same operation as the "rebuild" it was being compared
  against. Rewritten to build in 5 uneven chunks, publishing more events
  and restarting PGlite between each one, so the two sides of the
  comparison are genuinely different code paths.
- **`Nats-Msg-Id` de-duplication does not survive a backup/restore.** It
  survives a same-server resend and a plain process restart, but a
  `Nats-Msg-Id` resent after a `nats backup`/`restore` cycle, with the
  correct post-restore expected sequence, is accepted as a brand-new
  message — not recognised as a duplicate. Combined with a naive retry
  pattern (re-read the true sequence, republish the same payload and
  msg-id — exactly what this spike's own `appendWithRetry` does on a
  wrong-sequence rejection), this can silently create a **duplicate
  event**, and hence a duplicate real-world effect, for a command that
  had already succeeded. See "The idempotency rule for OpenCrane" below
  for the fix, demonstrated in `tests/07-dedup-lost-on-restore.test.ts`.
- **Backup/restore via the official `nats` CLI just works** and is fast at
  small scale (instant for 200 messages, and now verified message-by-
  message, not just by count); it was not re-tested at the 1M scale
  (condition 6 uses its own small, independent fixture — see "Deviations"
  below for why) so backup/restore timing at large N is not yet known.
- **`natscli`'s versioning has been decoupled from `nats-server`'s**: the
  latest stable natscli is `v0.5.0`, not a `v2.x` matching the server. This
  is normal (confirmed via the GitHub API: not a draft, not a prerelease)
  and not a sign of anything stale — just a naming-scheme note for whoever
  next has to "get the latest CLI".

### The idempotency rule for OpenCrane (from the condition-7 finding)

**Never rely on `Nats-Msg-Id` alone to stop a retried command from
creating a duplicate event.** It only protects within its duplicate
window (2 minutes by default) and it does **not** survive a
backup/restore. A Phase 1 command handler that must not double-execute
(anything that produces a real-world effect) needs its own **command
ledger**: a small table in the content database (Postgres/CNPG — PGlite
stands in for it here), keyed by the command's own id, checked **before**
any append is attempted, and written in the same transaction a real
handler would use for anything else. This ledger is ordinary Postgres
content, so it is backed up and restored on its own normal schedule —
independent of the event store — which is exactly why it survives the
failure this finding is about. The expected-sequence check
(`Nats-Expected-Last-Subject-Sequence`) still does its own, different job
alongside this: it serialises two *different* commands racing for the
same entity stream. The ledger is what stops the *same* command being
turned into a second event. See `src/idempotent-command.ts` and
`tests/07-dedup-lost-on-restore.test.ts` for the mechanism and a test that
would fail if this were wrong.

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
  input, not by copying these files. The one piece worth carrying forward
  deliberately is the *shape* of `src/idempotent-command.ts` — a
  command-ledger check before any append — not its PGlite implementation.
- **Condition 2's "crash" is a real `SIGKILL` of a separate OS process**
  (`src/projection-worker.ts`, run via `src/worker-proc.ts`), not a
  simulated failure inside the test's own process — see "Findings" above
  for why the earlier version of this test didn't actually prove what it
  claimed.
- **Condition 3's "incremental" build is 5 uneven chunks (37+61+53+79+70),
  interleaved with more publishing and a PGlite restart between each
  chunk** — a genuinely different code path from the single full-drain
  "rebuild" it's compared against (see "Findings" above).
- **Condition 6 now compares every message, not just counts and each
  subject's last message** — subject, stream sequence, header keys and
  exact payload bytes, for all 200 messages, in stream order.
- **Condition 7 is a new test, not in the original plan.md Phase 0
  table** — a finding made while reviewing this spike (`Nats-Msg-Id`
  de-dup lost on backup/restore) that mattered enough to prove and fix
  rather than just mention in prose.
- **`src/projection-worker.ts` is run with Node's `--experimental-strip-types`**
  (spawned by `src/worker-proc.ts`) so condition 2 can SIGKILL a genuine
  separate process without a separate build step. This is an experimental
  Node flag (stable-ish since Node 22.6, still warns on stderr). It is
  fine for spike test infrastructure but should **not** be assumed as the
  way Phase 1's real projection worker gets run — that's a normal build
  step, not a test-only convenience.

## Open questions for the owner

1. **Is the measured write-unavailability window on a killed JetStream
   leader (≈4.3–5.3s across the 5 required runs, ≈4.3–7.1s across 10 runs
   total — see "Re-run" above) acceptable?** events.md doesn't currently
   set a target for this. If not, the mitigation is operational (faster
   election timeouts, or accepting it as a rare-failure cost) rather than
   architectural — R3 itself already prevented any data loss or
   reordering, in every run measured.
2. **Should the PostgreSQL event-store fallback be removed from plan.md's
   open decisions**, now that JetStream has passed all 6 original
   conditions (plus the condition-7 finding, which has a demonstrated
   fix, not a blocker)? It was not spiked here (plan.md's S0.7 pass
   condition only covers JetStream) and keeping it "documented but
   dormant" vs. removing it outright is a plan.md edit outside this
   spike's remit — this spike and its ADR draft take no position either
   way.
3. **Backup/restore timing at large (1M-subject) scale is unknown** — do
   we need that number before Phase 5's "backup/restore of Postgres,
   Cognee and snapshots together" qualification work, or is small-scale
   correctness (proven here, now message-by-message) sufficient for the
   Phase 0 gate and large-scale timing can be measured later against a
   real silo's actual size?
4. **The append-latency numbers (p50 0.14–6.36ms, p99 0.26–36.47ms across
   5 runs) are dominated by how loaded the measuring machine was**, not
   by JetStream itself — this spike's own development machine had other,
   unrelated agent sessions running concurrently during some of these
   runs. Worth a controlled benchmark on a dedicated/idle machine (more
   samples, known background load) before using either end of this range
   for capacity planning.
5. **New, from the condition-7 finding: does any existing design note
   already assume `Nats-Msg-Id` is sufficient for command idempotency?**
   If so, it should be corrected to require the command-ledger pattern
   described above ("The idempotency rule for OpenCrane") before Phase 1
   command handlers are written.

## What's in this folder

```
src/
  nats-proc.ts          spawn/stop real nats-server processes (single node or clustered)
  jetstream.ts          conditionalAppend, appendWithRetry, stream/consumer helpers
  projection.ts         PGlite-backed projection + checkpoint, one transaction per event
  projection-worker.ts  standalone process (run with --experimental-strip-types) for the
                        REAL crash test in condition 2 — the test SIGKILLs this, not a
                        simulated crash inside the test process
  worker-proc.ts        spawns projection-worker.ts as a child process, feeds back its
                        stdout lines so the test can wait for READY / APPLIED / DONE
  idempotent-command.ts the fix for "Nats-Msg-Id de-dup is lost on restore": a command
                        ledger (Postgres content) checked BEFORE any append, so a
                        retried command can't create a duplicate event/effect
  pool.ts               tiny concurrency-limited worker pool (no external dep)
  measure.ts            RSS/disk sampling helpers (ps / du)
  ports.ts               free TCP port allocation
  hash.ts                SHA-256 of a JSON value, for rebuild-equality checks
tests/
  01-conditional-append.test.ts
  02-ordered-replay.test.ts       REAL process kills (SIGKILL), not a simulated crash
  03-rebuild-by-replay.test.ts    chunked, interleaved incremental build vs. full rebuild
  04-r3-failover.test.ts
  05-scale-1m.test.ts
  06-backup-restore.test.ts       compares EVERY message, not just counts/last-message
  07-dedup-lost-on-restore.test.ts  new finding + the idempotent-ledger fix, demonstrated
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
| tweetnacl | 1.0.3 (transitive, via @nats-io/nkeys) | Unlicense |
| @electric-sql/pglite | 0.5.8 | Apache-2.0 |
| typescript | 7.0.2 (dev) | Apache-2.0 |
| vitest | 5.0.3 (dev) | MIT |
| @types/node | 26.6.3 (dev) | MIT |
| lightningcss + darwin-arm64 binary (dev, transitive via vitest/vite) | 1.33.0 | MPL-2.0 |

All OSI-approved. Full dependency tree: 90 packages — Apache-2.0 (29), MIT
(46), MPL-2.0 (12, dev-only), ISC, BSD-3-Clause and Unlicense (1: tweetnacl).

## Disk footprint

- `node_modules/`: 94 MB
- `.tools/`: 42 MB
- `.state/`: 0 B at rest (each test file creates and then deletes its own;
  peak during condition 5 was ≈152–161 MB for the 1M-subject stream,
  deleted in that file's `afterAll` — confirmed with `df -h /` and
  `du -sh .state` after all 5 re-runs, every time)
- **Total resting footprint: ≈136 MB**, well under the 1 GB budget. Peak
  transient footprint during a full `npm test` run (while condition 5 is
  at its largest) is ≈300 MB (136 MB resting + ≈161 MB transient stream
  data), also comfortably under budget.

## Environment this was run on

- macOS (darwin/arm64), Node v22.15.0
- nats-server v2.15.0, natscli v0.5.0 (both official release binaries)
- The 5-run re-verification (condition 4's flake fix; the window/RSS/
  throughput ranges above) was done on this same machine while several
  other, unrelated agent sessions were also running their own test
  suites — real concurrent load, not a clean benchmarking environment.
  That explains the wide throughput/latency ranges; it does not affect
  any correctness claim, all of which held in every run.
- No Docker, no Kubernetes, no cloud calls, no secrets — local processes
  only, as required
