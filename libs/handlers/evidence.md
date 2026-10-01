# Dispatcher runtime evidence

Date: 1 October 2026. Source: `work/dispatcher`, based on `f65741c`;
this receipt accompanies the source and tests in the same commit.
Environment: Node 22.23.3, PostgreSQL 17.11 in local `pg-test`, and real
NATS fetched by `pretest`. Each handler test creates a fresh PostgreSQL
database and NATS data directory and removes them after the test.
No deployed silo or production credentials were used.

Final gates on this source:

| Command | Result |
| --- | --- |
| `npm ci` | PASS; lockfile install, 0 audit vulnerabilities |
| `npm run lint` | PASS; no warnings, all five stages, 124 modules / 288 dependency edges, 31 Markdown files, 90 local links |
| `npm run typecheck` | PASS; all nine workspaces |
| `npm run check:events` | PASS; 70 event types and both named subscription sets |
| `PG_TEST_URL=<fresh database> npm test` | PASS; 751 tests across 37 files, including all 14 handler tests |
| `npm run build -w @opencrane/web` | PASS |
| `npm test -w @opencrane/web -- --watch=false` | PASS; 27 tests across 2 files |

The final successful full run used fresh database `dispatcher_handoff`, at
10:19 UTC, in 47.40 seconds. Running every gate concurrently first caused
an existing PGlite test's five-second timeout; a rerun against the reused
PostgreSQL database then failed the projection suite's fresh-state assumption.
The final run used a fresh database with the build/typecheck load removed.
No test timeout or existing projection code was changed.

| Test / expected durable outcome | Result |
| --- | --- |
| Two named subscribers; per-stream order, single writer and cross-stream overlap; invitations only reach members | PASS |
| A failed write rolls back; retry waits for backoff, succeeds once, and logs attempt/handler/event/stream fields | PASS |
| Poison head reaches dead letter, holds its successor while another stream progresses; maintenance preserves the head; replay keeps its position | PASS |
| Real members projection writes through the transaction; a new duplicate job after original-job deletion has no second effect | PASS |
| Dispatcher SIGKILL before and after two-handler fan-out commit; restart preserves both queues, sequence and effects | PASS |
| Worker SIGKILL before and after effect/receipt commit; expiry and restart preserve sequence without repeated committed writes | PASS |
| Long SQL, an unsettled callback and concurrent SQL all time out; other-stream expiry progresses; late writes are refused | PASS |
| A swallowed SQL error still fails the attempt and holds its successor | PASS |
| A foreign-silo event is refused with no jobs or checkpoint advance | PASS |
| Subscription drift and incompatible retention settings are refused | PASS |

Executable proof: [integration tests](test/runtime.test.ts) and
[crash harness](test/crash-process.ts).

The crash harness uses IPC barriers around real transactions and SIGKILLs
a separate process. It never substitutes a fake NATS server, database or
queue. Worker recovery explicitly runs pg-boss supervision after lease
expiry; production runs the built-in supervisor on its normal interval.
Idempotency assertions count unconstrained effect rows, so duplicate writes
cannot hide behind the test table's uniqueness constraints.

NOT RUN: fresh Kubernetes installation, NATS R3 failover, PostgreSQL failover
or disk loss, network partitions/ambiguous commit replies, external-effect
idempotency, OpenFGA implementation, operator UI and alert delivery, durable
log/trace export, retention pruning and runtime image dependency inventory.
This proves the local event-core slice, not the complete Phase 1 journey.

Independent review pass 1 found one blocker: a stuck handler retained its
transaction lock after the JavaScript timeout, delaying pg-boss failure and
unrelated expired claims. The fix races the transaction callback against
abort, limits SQL to the remaining attempt time, and fences late queries.
Pass 2 found that concurrent queries could still queue stale timeout values.
The final repair serialises the entire guard/configuration/query operation
and computes the remaining time when each operation actually starts. It
also fails the attempt if the callback swallows a SQL error. The expanded
handler suite passes 14 tests; a separate concurrent-SQL run passes its
regression. All final gates above pass. The concurrent-query regression
requires rollback and unrelated-stream supervision within 1.5 seconds
after observing an expired claim (one-second attempt limit).

Review approval is **HELD**: both independent passes returned FAIL. The
reported cases have been repaired and tested by the builder, but the last
repair has no independent verification. The two-pass limit in the
[standard](../../docs/process/standards.md) requires the owner's decision
before integration; no third review was requested. The local branch commit
is a reviewable handoff, not a claim that the change is approved to land.
