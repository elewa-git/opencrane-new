# S0.8: handler runtime

**Recommendation: pg-boss for reactions, provisionally. S0.8 remains PARTIAL.**
Three clean host runs now establish the tested ordering, retry, crash-recovery
and operations conditions for both pg-boss and PostgreSQL-backed Temporal.
Visibility, production budget integration and the linked licence audit remain
open. [ADR 0004](../../docs/adr/0004-handler-runtime.md) records the decision.

The rejected Temporal local-activity budget variant is still skipped unless
`S08_UNSAFE_LOCAL=1`; its earlier evidence exceeded the ceiling. The new logs
also contain expected warnings and errors from deliberate worker termination
and deliberate application failures in retry and visibility tests. They are
not all worker-kill messages, and none caused a test failure.

## Results

A **PASS** requires a meaningful assertion and three consecutive runs from
fresh data. **PARTIAL** means some evidence exists but the full condition is
unproved. **NOT_RUN** means no behaviour measurement. The table distinguishes
runtime behaviour from application code added around it.

| Candidate | 100 × 100 order / parallelism | Retry / poison / dead-letter | SIGKILL / effect once | Visibility | Budget reserve / settle | Operations | Licence / SDK |
|---|---|---|---|---|---|---|---|
| pg-boss 12.35.0 | PASS (3×) | PASS (3×) | PASS (3×; guarded effects) | PARTIAL | PARTIAL | PASS (3×) | MIT; typed SDK; npm inventory recorded |
| Temporal 1.32.0 / SDK 1.24.0 | PASS (3×) | PASS (3×) | PASS (3×; guarded effects) | PARTIAL | PARTIAL | PASS (3×) | MIT projects; linked dependencies not fully audited |
| Hatchet v0.107.2 reviewed | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | MIT; source build not attempted |
| Restate server | EXCLUDED | EXCLUDED | EXCLUDED | EXCLUDED | EXCLUDED | EXCLUDED | BSL-1.1, not OSI-approved |

The host runs in [verified-orch1.txt](evidence/verified-orch1.txt),
[verified-orch2.txt](evidence/verified-orch2.txt) and
[verified-orch3.txt](evidence/verified-orch3.txt) each passed 20 test files and
48 tests, skipped one intentional local-activity experiment, and left zero
owned state directories. They used embedded PostgreSQL and the Temporal
development server. This is live evidence for the tested topology, not proof
of production HA or exactly-once external calls.

## Current local evidence

The full runs processed 10,000 ordered events per runtime, exercised four
attempt poison flows, crash recovery, repeated delivery, continue-as-new,
visibility APIs/UI shell and operations measurements in all three invocations.
Visibility stays PARTIAL because complete durable attempt logs and rendered log
UI were not established.
[Machine-readable summary](evidence/verification-summary.json) includes the
final source hashes and the evidence file mapping.

The workflow-state budget benchmark passed three clean dev-server invocations
(`verified-memory-1.txt` through `verified-memory-3.txt`): 1,000 sequential
reserves, 100 concurrent reserves, 50 settlements and 30 further reserves.
Exactly 50 initial holds and 20 later holds fit; the balance went 500 → 300 →
500 cents. Sequential p50 was 3.3–3.4 ms and p99 6.0–24.1 ms; concurrent p50
423–664 ms and p99 2,287–2,418 ms. This narrower primitive passed; the complete
budget condition remains PARTIAL because the event-store/durable-write path
and recovery are unproved. Each 1,000 Updates added 5,004 history events.

The offline checker and child-process cleanup suite passed 10 assertions in
three separate invocations (`verified-offline-1.txt` through `-3.txt`). This
includes deliberately invalid intervals and money values, plus an actual
child ignoring SIGTERM that must be killed and reaped. It does not substitute
for runtime delivery tests.

## Scenario and controls

- Both ordering tests dispatch 100 sequential events on each of 100 keys, using
  the same seeded 2–12 ms handler delays. The common checker verifies every
  sequence, loss, duplicates and non-overlapping intervals per key, then
  requires cross-key concurrency >1. It rejects invalid timestamps too.
  The initial dev run had seven concurrent handlers and correct order, but
  failed an inherited >8 threshold unrelated to the brief; both candidates
  now use >1 and report actual concurrency. Unkeyed work must break the rules.
- Both poison scenarios allow four attempts, require other keys to finish
  before exhaustion, hold successors behind the failed head, and retry that
  head in place. Temporal uses application workflow state for dead letters.
  pg-boss `redrive()` copies the failed job to the tail and leaves the original
  head blocking; use `retry()` for an ordered repair. The inherited run
  demonstrated this with `[0, 1, 0]` after redrive plus retry.
- Crash tests kill real child processes before the effect and after the effect
  but before acknowledgement. The unguarded control must duplicate the effect.
  This proves a guarded database effect only, not exactly-once external calls.
  Temporal's before-effect test now kills immediately, before replacement
  startup, avoiding a race with workflow compilation.
- Visibility tests assert queue/workflow metadata through SQL, gRPC and HTTP,
  and pg-boss's first-party dashboard HTML. Temporal's UI shell and backing API
  are checked; browser rendering is not. Both runtimes need application logs
  for complete per-attempt history. The example log arrays are volatile, now
  printed explicitly, and do not prove durable logs or a complete log UI.
- Budget payloads and balances use integer `…Cents` fields. The benchmark is a
  **test double** using PostgreSQL tables or workflow state, not OpenCrane's
  event-store command path. Neither budget adapter qualifies production
  idempotency, duplicate settlements, failover, lost replies or rebuilding
  from JetStream. The in-process baseline's advisory lock does not fence an
  old leader; its connection test is not a two-process failover proof.
- Temporal requires an explicit awaited loop and an Update mutex. Single-threaded
  workflow JavaScript alone does not prevent interleaving at `await`.
  Continue-as-new is tested over 400 events, but the carried `seen` list grows
  without bound; this is not a production retention design.

## Inherited measurements (one run, not current PASS)

Numbers below are copied from `evidence/run-1.txt`, all on the same machine.
They are observations, not repeatable latency guarantees. The two budget
implementations use different test-double persistence paths.

| Measurement | pg-boss | Temporal |
|---|---|---|
| 10,000 events | 75.2 s; maximum concurrency 28 | 46.6 s; maximum concurrency 33; PostgreSQL server |
| 1,000 sequential reserves, p50 / p99 | Polling 21.1 / 256.8 ms; NOTIFY 3.1 / 7.9 ms | Durable activity 49.9 / 79.3 ms; memory-only 5.0 / 26.4 ms |
| 100 concurrent reserves, p50 / p99 | Polling 2,910 / 5,509 ms; NOTIFY 24,062 / 48,116 ms | Durable activity 1,796 / 2,189 ms; memory-only 683 / 2,357 ms |
| Accepted at 500-cent ceiling, 10 cents each | 50 / 100 | 50 / 100 for ordinary activity; local-activity ledger reached 740 cents: FAIL |
| App / worker RSS after 5,000 events | 104.6 MiB | 254.6 MiB (all services together); 143.8 MiB (split) |
| Server RSS after load | Existing PostgreSQL | 299.7 MiB all-in-one; 348.8 MiB across four services |
| PostgreSQL group RSS | 271.6 MiB / 19 processes | 878.2 MiB / 60 processes (all); 524.7 MiB / 60 (split) |
| Data directory | 65.8 MiB | 225.8 MiB (all); 226.2 MiB (split) |
| Idle DB connections / commits per second | 4 / 42.6 | 41 / 70.1 (all); 41 / 55.0 (split) |

RSS sums double-count shared pages; they are not unique physical memory.
pg-boss needs Node workers and the silo's existing PostgreSQL, plus an optional
dashboard. Temporal adds frontend/history/matching/worker services, persistence
and visibility schemas, application workers and a separate UI. Local split
processes do not establish production HA, sizing, TLS or operational recovery.
The SQLite dev server is not a production option.

## Licences and footprint

[Installed npm inventory](evidence/npm-licences.tsv) records each of 230
installed packages by name, exact version, licence and path. The complete
[lockfile inventory](evidence/locked-licences.tsv) also includes optional packages
not installed on this host.
[Binary inventory](evidence/binaries.tsv) and
[hashes](evidence/binary-sha256.txt) identify downloaded executables.
`unionfs`'s missing package licence is resolved by its Unlicense file. For
`type-fest` (MIT OR CC0-1.0), select MIT.
`caniuse-lite` is CC-BY-4.0 build data, accepted only for development by the
project rule; prebundle Temporal workflows outside a silo and exclude that
build dependency from runtime images. Linked Go/Rust/native-library licences
are **not fully audited**; [linked Go modules](evidence/linked-go-modules.tsv)
and [native libraries](evidence/native-libraries.tsv) record this gap explicitly.
The inventory is not a full production SBOM.
No new npm dependency was added during completion.

Only OSI-licensed candidate projects were executed. Restate was excluded
before installation. [Exclusions](EXCLUDED-CANDIDATES.md) records the exact
Hatchet limitation without claiming Docker-free execution is impossible.

`trim-tools` removes unused platform copies of the Temporal native SDK. Data
lives in `.state/` and is deleted after each test file; footprint tests now
release one topology before starting another. SWC uses `.cache/swc` rather than
the user's global cache. The final setup is about 701 MiB including that
cache (745 MiB at an observed ordering-run snapshot); bulky database state is removed. Do not run suites in parallel.

## Run

```sh
cd spikes/s0-8-handler-runtime
npm ci
npm run trim-tools
npm run fetch-tools
npm run audit:licences
bash scripts/run-all.sh 1 all
bash scripts/run-all.sh 2 all
bash scripts/run-all.sh 3 all
```

Use Node 22. Each run typechecks strict ESM / NodeNext TypeScript and asserts
that its owned state directory is empty before and after testing. Full runs
need local PostgreSQL shared memory and process inspection permissions.
The downloader pins CLI 1.9.1 and Server 1.32.0 and checks release checksums
when downloading. No Docker, cloud, provider calls or real credentials.

For the supported subset in this sandbox, replace `all` with `dev` (official
Temporal dev server) or `offline` (checker and process-cleanup controls). `memory` runs the
Temporal-only workflow-state budget benchmark with reserves and settlements;
it does not qualify the event-store path or the durable activity comparison.
`npm run test:pgboss` and `npm run test:temporal` run candidates separately.
`S08_UNSAFE_LOCAL=1 npm run test:temporal` enables the rejected local-activity
budget experiment with real no-overspend assertions; its previous
`answered + rejected === 100` check did not test correctness.

See [VERIFIER.md](VERIFIER.md) for adversarial findings and unproved conditions.
