# Adversarial verifier pass

This is a second pass against the inherited claims, not a restatement of the
candidate documentation. Scope: only this spike and ADR 0004 were changed.
No commits, staging, Docker, cloud or provider calls.

## Findings fixed or downgraded

| Finding | Why the earlier green result was insufficient | Action |
|---|---|---|
| Three clean runs claimed | `run-2.txt` and `run-3.txt` exit 143; run 3 starts dirty | Preserve raw evidence; remove blanket PASS claims |
| Budget local activities | Test checked only answered + rejected = 100 while ledger reached 740 cents against 500 | Reject variant; opt-in test now asserts the ceiling and balance agreement |
| Workflow single writer described as automatic | Async Update handlers interleave at await | Document awaited loop and mutex; retained overspending negative control |
| Arbitrary concurrency >8 | First dev run correctly completed 10,000 events with seven concurrent handlers | Both candidates require >1, the actual parallelism condition; keep measured count |
| Retry scenarios differed | pg-boss had four attempts, Temporal's slow profile five | Both poison scenarios now have four attempts |
| Incorrect crash timing | Replacement startup before killing the first worker could let the effect land first | Kill before spawning replacement; include startup in measured recovery time |
| Log visibility overstated | Last error/count are queryable; example per-attempt logs lived only in arrays | Print those arrays and retain PARTIAL for durable logs / complete UI |
| Budget units and storage | Unqualified amounts and SQL numeric permitted ambiguous units | `…Cents`, integer storage and safe-integer input checks; invalid-value controls |
| Cleanup reported zero after denied ps | A failed process-list command flowed into wc and printed 0 | Remove this false proof; await every owned child exit and check owned state |
| SIGKILL fallback returned early | Data removal could race a living server | Shared stop helper awaits exit; real SIGTERM-ignoring child control |
| Failed initdb leaked empty directories | Setup threw before returning a cleanup handle | Clean on setup error; retain failure evidence |
| Two footprint topologies coexisted | afterAll retained both clusters and skewed load / disk | Clean after each topology; trim unused native SDK platform copies |
| Timestamp checker accepted NaN/reversed intervals | Comparisons with NaN silently fail open | Reject invalid intervals; adversarial unit tests |
| Hatchet source builds said to be forbidden | The task never forbade them | Remove invented rule; explain untested Go/disk feasibility |
| Baseline leadership called failover | Two connections in one process, no fencing of old work | Limit claim; no production actor recommendation from baseline |
| Carry-over deduplication looked bounded | Temporal's `seen` list grows across continue-as-new | Record unbounded state as an unresolved production design issue |

## Evidence and mutation checks

`verified-final-*.txt` holds independent dev-server runs with fresh SQLite
state. `verified-offline-*.txt` holds checker and process tests (10 assertions, three
clean invocations). `verified-memory-*.txt` holds three narrower workflow-state
budget measurements; they do not qualify a production budget actor. An initial
`dev-1.txt` failed only the >8 concurrency assertion; it is not counted as a
passing run. `dev-third-driver-error.txt` preserves a driver syntax error
after passing tests, caused by editing the runner while bash held it open;
the final third run was repeated successfully with the runner unchanged. The exploratory `baseline-raw.txt` records PostgreSQL setup
failures and the initial compiler-cache permission error. SWC now uses a
writable cache inside this folder.

`node scripts/verify-mutations.mjs` deliberately changes implementation code,
runs the relevant real assertion, checks the expected failure and restores
source in `finally`. It targets missing per-key awaiting, missing retries,
fixed-delay retries, skipping a poison head, missing attempt logs and accepting
fractional money, plus removing the budget ceiling check. All seven changes
were detected by the expected behaviour assertions (see
[evidence/mutation-summary.txt](evidence/mutation-summary.txt)).
Do not run it concurrently with other tests. Per-mutation output and the
completed list are recorded under `evidence/mutation-*`.

The retained live controls additionally remove pg-boss FIFO, remove the
Temporal budget mutex, remove effect idempotency and redispatch after queue
retention. Their **current** PostgreSQL-dependent execution is NOT_RUN;
only the inherited single-run evidence is available. Static review cannot
promote those conditions to PASS.

## Still unproved

- Three current clean PostgreSQL-backed runs, including both crash windows,
  durable reserve/settle comparisons and production-process footprint.
- Real event-store conditional append, replay, leader fencing, late workers,
  lost reply recovery, duplicate reserve/settle handling and external effects.
- Durable logs for every attempt, browser-rendered log UI, multi-replica HA,
  server crashes, partitions, upgrades and long-term workflow deduplication.
- Full licences of transitive code linked into Go/Rust/native binaries and a
  production image proving exclusion of non-OSI build data.
- Hatchet source build and runtime behaviour. Restate is excluded by policy.

A local spike is not a production deployment qualification. The ADR stays
proposed, with S0.8 PARTIAL, until the missing gate has live evidence.
