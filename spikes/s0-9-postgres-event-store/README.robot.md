# PostgreSQL event store comparison

For people, read [README.md](README.md) first.

## Scope and recommendation

Issue #1094, parent #1031; owner decision of 12 November 2026. Compare JetStream
for events plus PostgreSQL for everything else with PostgreSQL for events too,
retiring NATS. pg-boss remains the job queue. ADR 0007 is **Proposed**, recommending
**defer a product switch** pending production recovery and dispatcher proof. The
owner decides. This tests the previously untested PostgreSQL fallback in ADR 0001;
it does not qualify Message DB or Emmett, adopt a migration, or supersede ADR 0001.

Decision 14 allows one minute for removing access. Today's two-second write check
remains unchanged. Restore work, the number of systems and removable code receive
at least equal weight to latency. This experiment changes no event or API fields.

## Storage contract

`src/postgres-event-store.ts` exposes the same seven method names and argument shapes.
It imports the existing event validator, command comparison and append outcome helpers.
It adds only `accessSubjects` to the throwaway append input: name the small streams
that grant access. It samples those positions before `checkAccess`, then checks them
inside the append transaction. Unlisted subjects cannot cause an access conflict.
Callers still provide subject expectations and may explicitly request the existing
stronger global or category condition. An omitted access list watches no access subjects;
a production caller migration must supply the complete list. This is not a drop-in
production replacement for current access callbacks.

One table stores `(position bigint, subject text, event jsonb)`. An index serves subject
history; a unique event-id index detects collisions. One transaction-scoped advisory
lock serialises append commits. Under that lock, `MAX(position) + 1` and one INSERT
allocate the position. No sequence object is used: rollback leaves no gap, and the
next writer cannot allocate a later position before the earlier writer commits.
There are no triggers, views, stored procedures or SQL business rules.

The deliberate ceiling is one append transaction at a time per database. A pool of
60 connections leaves room for 50 writer loops and probes. Conflict recovery runs after
releasing its connection, so waiting writers cannot starve recovery reads. History
reads use finite snapshots and batches of 256; subscription polls the tail every 100 ms.
A command key remains scoped by silo, subject and principal through the shared helper.
A failed COMMIT reply remains uncertain and the same command recovers its saved copy.

This is a single-primary experiment. `ensureStream` creates table/indexes and accepts
only replica count 1; it does not configure PostgreSQL replication. Read deadlines
reject late replies but do not cancel SQL already running. Append checks time and
cancellation before publication and uses a transaction-local statement timeout.
Pool acquisition, full network partitions, restart retries, late COMMIT cancellation,
HA failover, role permissions and shipped-image qualification are NOT RUN. Stored
rows are trusted here; production read parsing/retention protection remains necessary.

## Contract tests

The five requested files were copied from `libs/event-store/test` before implementation;
commit `9ad1762f7` records them and the expected failing import. They keep their original
assertions except the first NATS configuration assertion, which becomes table creation
plus two independent subscribers. Imports use the existing public entry point and a
PostgreSQL fixture. Access-change cases explicitly list the subjects changed by their
callbacks. The outcome test uses a separate adapter instance on the same database so
its read-failure injection does not accidentally stop the concurrent writer.

| Copied file | Result | Passed | Skipped | Failing reason |
| --- | --- | --- | --- | --- |
| `append.test.ts` | PARTIAL | 9 | 13 | None; transport cases below are NOT RUN |
| `append-outcomes.test.ts` | PARTIAL | 16 | 4 | None; transport cases below are NOT RUN |
| `history-checked.test.ts` | PARTIAL | 16 | 2 | None; transport cases below are NOT RUN |
| `read-event-at.test.ts` | PASS | 1 | 0 | None |
| `conversation-command.test.ts` | PASS | 6 | 0 | None |

The [machine-readable contract record](results/contracts.json) keeps every test name
and status without private paths. PostgreSQL fixtures create a random schema and drop
only that schema on close. They never delete the shared database or its container.

Skipped NATS contracts, all retained as skipped tests rather than counted as passing:

- Seven incompatible stream-setting rows and one operational-setting case: PostgreSQL
  has no NATS stream configuration, retention fields or replica provisioning API.
- Two real NATS restart/no-responder cases: PostgreSQL restart recovery is NOT RUN.
- Two publish retry/backoff deadline cases: this adapter has no NATS publish retry loop.
  The added SQL lock-timeout test checks an actual PostgreSQL refusal instead.
- One publication-position fault injected into `client.publish`: the injection cannot
  reach PostgreSQL. Global conditions remain in the adapter and copied history tests.
- Two outcome rows for a lost publish reply, one lost-attempt/later-rejection case and
  one failed duplicate-ack readback case: they exercise NATS acknowledgement ordering.
  The added lost-COMMIT test checks durable SQL data and same-command recovery instead.
- Two history cases that replace `client.publish` or return a NATS duplicate acknowledgement:
  these do not call the PostgreSQL adapter and would be false evidence if left enabled.

Six additional PostgreSQL tests cover unlisted activity, rollback without gaps,
50 concurrent commits, a real SQL lock timeout, and a saved COMMIT with its reply lost, including a broken rollback connection.
The access-change test was manually checked with its transaction comparison removed:
it failed as expected, then the comparison was restored. No retry or longer timeout
was added to make a failed acceptance check pass.

The global-only conflict test keeps the target subject position current, advances only
an unrelated subject, and refuses a new ownership write with the stale global position.
It verifies unchanged target history and success after refreshing only the global position.
Removing the `expectedGlobalSequence` comparison by hand made this test append incorrectly;
restoring it made the test pass. Omitting `accessSubjects` from the existing access-change
test also reproduced an incorrect append. The list and both comparisons are restored.
Two documentation checks failed before correcting the partial latency result and the
database prerequisites; they now protect those public claims.

## Measurements

`volume.test.ts` copies `libs/models/test/authority-volume.test.ts`: identical setup,
the same five rotating unrelated event categories, 0 and 100,000 added events, 30 calls
to each model/MCP/destination route, equal local history, same bounds and constant
non-budget authority-row counts. It adds backend labels, maximum and raw sample output.
The PostgreSQL adapter is injected into the existing model fixture without product edits.
That fixture still starts a NATS connection for its dispatcher setup; dispatch and
workers are stopped before timed calls. Its event log, budget and audit appends use
the selected store. This measures the log replacement, not a fully NATS-free silo.
Provider responses are local stubs; no paid model or real secret is used.

**(a) PARTIAL:** product model/MCP callbacks do not pass `accessSubjects`, so those
PostgreSQL appends compare no access positions inside the transaction. JetStream still
conditions its publish on the log position. The unprotected PostgreSQL timings below
are observations of unequal work; timings with transactional access-subject comparisons
are NOT RUN. The callback-only contract does not reveal the complete watched subjects
to this fixture. Supplying and verifying those subjects before a fair rerun remains work
outside this night's comparison. A destination authority read does not append.

Both stores are local single-primary fixtures. JetStream uses file storage and test TLS;
PostgreSQL uses the requested Docker image and loopback connection without TLS. Default
persistence settings are retained. Network transport, durability and replication are
not identical, so these are observations under this workload, not a capacity ranking.
The host has other work running. There is no isolated-host or repeated-night confidence interval.
The historical 222 ms p95 is context only, not a measurement in this comparison.

`pressure.test.ts` runs both backends in one process, sequentially. Fifty writer loops
append to fresh unrelated subjects while 100 valid writes check one unchanged authority
subject. Every probe overlaps all 50 loops. No artificial write is injected inside
`checkAccess`; it really reads and verifies the authority position. Each result is checked
against durable target history. Conflicts, unavailable and rejected outcomes are separate.
The loops are stopped and awaited before each fixture closes. This test starts with
small histories; it tests contention independently of the 100,000-event latency scenario.
Writer throughput is not compared: the two store phases naturally produce different counts.

The runner uses the shared disposable database only for normal contracts and the model
fixture's content/job projections. All PostgreSQL event logs for the 100,000-event runs
use its own `pgtest-clean-1094` container. The trap removes precisely that container with
`docker rm -f -v pgtest-clean-1094`; NATS fixtures close their own processes and directories.

## Restore comparison

**PARTIAL: counted design steps, not a completed silo restore drill.** Count one operator
phase per numbered row, not shell commands or replica Pods. Assume the same stopped,
validated backup cut, PostgreSQL cluster and external stores in both options. Put the
proposed event table in the existing projection database; this adds no fourth database.
The existing cluster has `projections`, `handlers` and `openfga`. A physical cluster
backup could capture all three and the event table at one recovery point, but this was
not exercised. Independent logical database dumps do not establish that guarantee.

| Step | Today's split | PostgreSQL event log |
| --- | --- | --- |
| 1 | Isolate traffic; stop writers, effects and computers | Same |
| 2 | Validate the matched backup cut, ownership and current custody inputs | Same |
| 3 | Restore the PostgreSQL cluster and all three databases to that cut | Same, including events |
| 4 | Restore the matched event archive into an empty NATS target; verify positions | Included in step 3 |
| 5 | Provision the dispatcher consumer omitted from the event snapshot | No NATS consumer |
| 6 | Restore and verify file objects | Same |
| 7 | Restore and verify each retained computer home | Same |
| 8 | Apply current key custody and permanent deletion records | Same |
| 9 | Rebuild projections/permissions; reconcile checkpoints and pg-boss work with effects off | Same |
| 10 | Restart server/models to clear summaries and other cached authority | Same |
| 11 | Compare event ids/order, rights, cents, jobs, objects and homes | Same |
| 12 | Reopen traffic and effects after the comparisons pass | Same |

Totals: **12 versus 10 phases**. The event/relational services shrink from **2 to 1**;
including file-object storage and computer-home storage gives **4 to 3 storage
responsibilities**, not 4 to 3 databases or Pods. PostgreSQL, pg-boss, OpenFGA, object
storage, computer storage and current secret custody all remain. Any additional enabled
store also remains in the coordinated restore. PostgreSQL concentration increases the
impact of a database outage and puts event writes beside queue/checkpoint traffic.

The split needs an independently matched JetStream cut and PostgreSQL recovery point;
putting the event table in the same PostgreSQL cluster removes that matching boundary,
not the need to coordinate external bytes, current deletion and external effects.
Today's event helper requires a reachable unchanged source, a standalone target and
one-replica archive. Offline-source and clustered event restore are not qualified.
The package still refuses CNPG backup/recovery settings; neither option has a complete
live coordinated restore. See the existing [package contracts](../../infra/package/README.robot.md#event-byte-restore)
and [combined restore limits](../../infra/package/README.robot.md#combined-event-and-file-restore).

## Code inventory

[The inventory](results/inventory.json) identifies **1,567 gross physical source lines**
in 12 files, against base `90a99afa75e508f32c505d82a4beacc45e236dfd`. It records each
file's SHA-256, selected declaration names and inclusive line ranges. It counts comments
and blank lines inside those ranges; it excludes tests and configuration. Run
`nice -n 10 node --experimental-strip-types spikes/s0-9-postgres-event-store/src/inventory.ts`.

| File | Candidate lines | Work remaining if NATS retires |
| --- | --- | --- |
| `libs/event-store/src/jetstream.ts` | 460 | Replace adapter functions; keep the seven-method contract and generic deadline wrapper |
| `libs/event-store/src/nats-connection.ts` | 53 | Remove NATS connections and callers |
| `libs/event-store/src/certificates.ts` | 17 | Remove NKey/client generation; retain generic TLS issuance where needed |
| `libs/handlers/src/dispatcher.ts` | 29 | Remove NATS consumer setup; rewrite delivery and retain pg-boss/checkpoints |
| `infra/package/event-backup-run.ts` | 47 | Remove NATS-only archive command |
| `infra/package/event-restore-run.ts` | 56 | Remove NATS-only restore command |
| `infra/package/event-backup.ts` | 65 | Remove snapshot protocol/configuration; retain integrity and ownership requirements |
| `infra/package/event-restore.ts` | 38 | Remove NATS transfer/server checks; retain object/key custody helpers |
| `infra/package/prepare-nats-routes.ts` | 242 | Remove route identity preparation |
| `infra/package/check-nats-inputs.ts` | 132 | Remove mounted NATS input checks |
| `infra/package/nats-placement.ts` | 304 | Remove NATS placement proof |
| `infra/package/nats-placement-collect.ts` | 124 | Remove NATS placement collection |

This is an auditable replacement/removal footprint, **not 1,567 net deletions**. Shared
contracts, validation, idempotency, outcome evidence, SQL checkpoints and pg-boss survive.
The new SQL implementation, production hardening, migration/export and caller changes
must be counted before a net saving can be claimed; that calculation is NOT RUN.
No NATS configuration, dependencies or product files are removed by this experiment.

## Checks and journey

Final measurement source: `bec6d64309e716503f835fc9575db28f6101ee42`, against
`90a99afa75e508f32c505d82a4beacc45e236dfd`. The
[environment record](results/environment.json) includes the complete measured code hash,
CPU, client versions and PostgreSQL image digest. Later commits contain documents/results only.
The tables and raw samples record the final verification run on 13 November. Both runner
executions passed their existing assertions; they do not qualify the omitted access work.
The expected outcome is unchanged authority work at both log sizes, bounded decision latency,
and durable probe histories matching each reported write outcome.

| Own check | Result | Observation |
| --- | --- | --- |
| `npm ci` | PASS | Installed this worktree's locked dependencies; none added |
| Changed-code ESLint with the spike's typed configuration | PASS | No errors or warnings |
| `npm run typecheck` under `nice -n 10` | PASS | All workspaces, package and dev-stack checks |
| Spike `tsc --noEmit` under `nice -n 10` | PASS | Strict NodeNext project including copied tests |
| `npm run check:events` | PASS | 174 catalogue types agree |
| `npx knip` | PASS | Two advisory existing configuration hints |
| `npx markdownlint-cli2` with no file arguments | PASS | Required repository Markdown inputs |
| `npm run lint:changelog` | PASS | Branch-named release note |
| Offline documentation links | PASS | 3,084 checked links; 0 errors |
| Measured source hash | PASS | Matches the final committed spike code |
| Private measurement container cleanup | PASS | Runner removed its container and volumes |
| Secondary stack cleanup | PASS | Both starts ran `down.sh`; slot 2 was confirmed free |
| Focused contracts, PostgreSQL and documentation tests | PASS | 56 executed, 19 skipped; repeated with the shared disposable database |
| Access comparison mutation | PASS | Removing the comparison made the access-change test fail; omitting the watched list also reproduced an incorrect append |
| Global-only conflict mutation | PASS | Removing the global guard made the new test append; restored guard refuses it and accepts a refreshed global position |
| Clarity checks | PASS | Unbraced branches failed ESLint before cleanup; five inline call-site callbacks became zero; unchanged measurement assertions passed twice |
| Contract database instructions | PASS | README and runner name the server, URL, port and permissions; first contract stage ran against the shared disposable server |
| Fresh-machine database provisioning | NOT RUN | The shared disposable server already existed; it was kept intact |
| Lost-COMMIT/broken-rollback regression | PASS | Failed before the fix; both parameter rows now pass |
| Product source diff | PASS | `git diff --stat origin/main -- apps libs infra` is empty |
| Core journey on a fresh secondary dev stack | PASS | 13 November 2026; rebased head `583707da17fc52d81ef5ace1da8dc6fc80758d84`; all core journey steps passed on fresh secondary slot 2 |

The core journey passed on a fresh secondary slot 2 after rebasing onto
`1e85888428e91cec9a39bfada3b7f99649b61766`. It ran on 13 November 2026 at head
`583707da17fc52d81ef5ace1da8dc6fc80758d84`. Owner bootstrap, managed-provider setup and
website readiness passed. The full journey passed sign-in and access refusals, member and
assistant setup, upload and chat at 390 px and 1280 px, live view and revocation, audit,
budget limits, replay checks, token boundaries, sign-out and listener checks. Two upload
transport attempts reported `net::ERR_FAILED`; the retry flows passed with no duplicate
files or preview retries. Approval journey remains skipped because its required #45 rows
are not ready. Screenshots from the run are recorded here:
[390 px chat](results/core-journey-390.png) and
[1280 px chat](results/core-journey-1280.png). The secondary stack was taken down after
the journey completed. No product behaviour changed.

Full root tests are deliberately NOT RUN; only this experiment's focused suites run.
Live disaster recovery, replicas/failover, production NATS retirement and migration remain
NOT RUN. The core journey is a regression check of the unchanged product, not a PostgreSQL
product qualification. Measurement work ended within the six-agent-hour allowance.
