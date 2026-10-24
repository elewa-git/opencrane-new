# Handlers

For people, read [README.md](README.md) first.

`@opencrane/handlers` is the Phase 1 dispatcher and SQL handler runtime.
Its public entrypoint is `src/index.ts`. Commands still append only to the
[event store](../event-store/README.md); business rules remain TypeScript.
The host owns PostgreSQL/NATS connections, TLS, credentials and telemetry.

```ts
import { HandlerRuntime, registerHandler, dispatch } from '@opencrane/handlers';
import { members } from '@opencrane/projections';

// db is pgDb(pool); connection is this silo's NATS connection.
await members.create(db);
const runtime = new HandlerRuntime({ db, logger, silo: 'acme', handlers: [
  registerHandler('update-members', (event, tx) => members.apply(tx, event)),
] });
await runtime.start();
async function startWorkers() {
  await runtime.work(4);
}
await dispatch(connection, runtime, abortController.signal, startWorkers);
await runtime.stop();
```

Use a dedicated silo database and its `pgboss` schema; jobs and handler SQL
writes must share the supplied database. The role needs schema/table creation
and DML rights. Run `npm run provision` with command credentials first (R3 by
default; `NATS_REPLICAS=1` for local tests). Start
telemetry in the host for real trace ids; every valid handler attempt uses
observability's `runHandler` (name, event id, stream, attempt), except memory and connection cleanup.
Its attempt errors may contain private custody details, so the runtime replaces them with
a fixed error before pg-boss stores the failed attempt. It does not log the raw error.
Queue errors
are logged; dispatcher errors reject its promise and require host restart.

`provision.ts` uses the event-store package's five-second management request
timeout for EVENTS lookup and creation. The real PostgreSQL/NATS test fixture
starts that production command against an empty, separate NATS server each time.
It does not retry provisioning. See the event-store package's
[timeout contract](../event-store/README.robot.md) for bounds and failure behaviour.

The durable `handler-dispatcher` consumer reads `ev.>` from the beginning,
with explicit acknowledgements and one unacknowledged message. All subscribed
jobs and a global SQL checkpoint commit together before acknowledgement.
The checkpoint row serialises overlapping dispatchers and rejects gaps,
silo mismatches and subscription changes. Registration takes a catalogue
name and handle function; subscriptions come from `libs/events`, checked
against the [catalogue](../../docs/architecture/events.md) by `check:events`.
The ops host registers the OpenFGA permission reaction from `libs/authz`.

One `key_strict_fifo` queue per handler keys jobs by stream id. Defaults:
four worker slots, five retries, exponential backoff starting at one second,
and a 60-second attempt timeout. Different streams can progress together.
The worker locks the fetched queue attempt through its SQL transaction;
handler writes and the event-id receipt commit together. Abort rolls back even
when a callback never settles; SQL calls are serialised and each statement
uses the remaining attempt time. Late callback queries are refused after
the transaction closes. Each callback also receives `{signal, deadline}` as its third
argument. The signal is the job attempt cancellation; the deadline uses `performance.now()`.
Reactions with external work must pass these limits into that work. Gateway preparation
uses them for its content lock, history reads and conditional append. Any SQL error fails the attempt even if caught. Handlers must write
only through `tx`. Receipts survive queue-job deletion. External services
need an event-id idempotency protocol of their own; this API cannot make an
external call atomic with SQL. Do not run the projection runner and this
runtime against the same projection tables concurrently.

Failed heads remain in place and block their stream. Monitor
`runtime.deadLetters(name)` and pg-boss queue errors in the host. Each exhausted job
also has a diagnostic copy in `<handler>-dead`; these queues disable automatic deletion.
`cleanup-memory` handles correction and forget copies after confirming that the original is failed.
Its callback records one durable unavailable result. The runtime then logs only the
change id, scope id and original job id. Duplicate copies cannot add another result.
The ops recovery pass checks the same retained failed original after restart. If the
callback exhausted its retries while the event store was down, recovery records the
missing result and logs the same safe alert. A saved completion or unavailable result
prevents another report. The failed original stays available for operator replay.
Repair with `runtime.replay(name, originalJobId)`: it retries the original
head once, preserving order. Never redrive the diagnostic copy. An operator can deliberately cancel a failed
original with `npm run ops -- jobs --cancel <id>`. This records a cancelled job,
keeps receipts and allows later jobs on that stream to run. There is no automatic skip.
The pinned pg-boss adapter sets queued event jobs' `keep_until` to infinity
inside enqueue's transaction and disables finished-job deletion. This uses
pg-boss 12.35's schema; upgrades must rerun retention/replay tests. Queue rows
and receipts currently grow without pruning. Monitor database capacity.

Workers in `src/queue.ts` fetch one job per worker slot and poll every 0.5 seconds.
This polling continues while a large historical queue drains. The chunked upgrade
scan does not remove that limit. Million-event throughput, database load during
that drain and the time needed to finish it are NOT RUN. A measured large-queue
run is needed before changing the polling interval or batch size.

## Recovery and subscription changes

`prepareDispatcher(runtime)` prepares a new manifest or returns false after logging
an existing subscription mismatch. Call it under the `handler-dispatcher` database
lock, before event writers start. It never resets existing jobs or checkpoints.
Dev startup uses it before bootstrap; dispatch uses the same check before workers.

Stop dispatchers/workers before recovery. PostgreSQL is disposable execution
state and content: rebuild it together with the consumer from EVENTS, with
external reactions disabled. Keep receipts while preserving external state.
Subscription upgrades preserve the database, consumer and receipts. They do not
rebuild projections or reset the consumer. The dispatcher holds the PostgreSQL
`handler-dispatcher` advisory lock for its whole lifetime, including when a changed
manifest leaves it waiting for shutdown. It logs changed handlers, added/removed
event types and `npm run ops -- upgrade-handlers --dry-run` before waiting.
An order-only change gets a separate, plain log line. The ops host starts workers
and the computer watcher only after this check. Computers are not suspended while
the dispatcher waits. An operator stops them as part of the upgrade procedure.

The [operator upgrade procedure](../../apps/ops/README.robot.md#handler-subscription-upgrade)
stops clients, drains old jobs with decision services available, then stops
all database clients and event writers. The command checks the dispatcher lock
and refuses other sessions in the handlers database, including idle clients,
logical replication workers and unknown or null backend types. Only these named
PostgreSQL processes are ignored: autovacuum launcher, autovacuum worker,
background writer, checkpointer, walwriter, archiver and logical replication
launcher. Each has its reason beside the allow-list in `src/upgrade-scan.ts`.
The startup process remains blocking because it replays changes from the log.
Test diagnostics select only PID, backend type, state, wait event type and timing
columns. Client query text and application names never enter those reports.
Original jobs in created, retry or active state block a changed manifest.
Failed originals are listed in the report and do not block an upgrade.
Diagnostic dead-letter copies do not block it. A successful rerun with an equal
manifest queues nothing, even when backfill jobs are still waiting.

Each added `(handler, eventType)` gets historical jobs in EVENTS order through
the stored SQL checkpoint. Batches of at most 256 events commit their jobs and
progress together. `handler_upgrade` records the target and previous manifests,
target checkpoint, last scanned sequence, event counts, queued-job count and start time.
Batch insertion times use that saved start time and count. Their order survives
restart, and every historical job sorts before a later live job.
After a crash, the same code resumes at the next sequence. A different target
manifest refuses the unfinished upgrade. Jobs use `start_after = infinity` while
the scan runs; the final transaction releases them and changes the manifest.
The dispatcher checkpoint stays unchanged. Workers remain stopped throughout.

The command inserts one job batch per matching handler, then updates retention
and order in one statement. It logs events scanned and jobs queued after each
chunk. History timeouts retry the chunk up to five times, with delays of 250 ms,
500 ms, 1 s, 2 s and 4 s. Other failures stop immediately. Committed chunks remain
available for the next attempt. Removed handlers/types and order-only changes
skip the history scan. New queues may remain after failure; no reaction runs here.
Events beyond the checkpoint stay with the durable consumer after restart.

Dry-run takes no advisory lock, creates no tables or queues, and writes nothing.
It works while a changed dispatcher waits. It checks unfinished jobs, lists failed
originals and counts each newly subscribed historical event, including receipted
events. During a partial upgrade, it ignores that upgrade's parked jobs and reports
the whole plan from sequence 1. It still refuses other unfinished jobs.

## Old-event audit

The rule is: **a handler must be correct when given an old event after later events were applied**.
A SQL receipt is a saved note that the handler finished the event. A successful
no-op gets the same receipt as any other successful job. OpenFGA also saves its
own receipt alongside permission changes. Its reaction receives the event store
and skips an old change when a later change for the same person or resource has
already been applied. It saves a receipt and logs the skip.

The table lists every pair enabled by the ops host today. Which pairs need
backfill depends on the installed manifest. It includes retained pairs so that
adding a whole handler cannot miss one of its event types. Tests below use real
NATS, PostgreSQL and OpenFGA where those services hold the result.

| Handler | Event type | Current-state check | Test |
| --- | --- | --- | --- |
| stop-mcp-instance | mcp.instance_stop_requested | Require the saved current stop and Pod UID; prove Kubernetes ownership before stopping; reread before recording absence. Enabled only with MCP_KUBE_NAMESPACE. | mcp-personal-k3d |
| cleanup-departure | member.removed | Require the saved reviewed removal; read current indexed resources; keep one removal outcome per resource. Suspend only idle personal computers; require group/grant OpenFGA receipts before one completion record. Busy computers use existing retries. | departure-cleanup |
| prepare-personal-key | member.joined | Check current membership; retain the existing private key, including for none. | personal-keys |
| prepare-personal-key | silo.owner_bootstrapped | Skip a removed owner; retain the existing private key. | personal-keys |
| create-assistant | member.joined | Skip a removed member or an existing assistant. | assistant-choice |
| create-assistant | silo.owner_bootstrapped | Check membership before creating the owner assistant. | assistant-choice |
| claim-computer | assistant.created | Check the personal owner is active; keep later computer lifecycle events. | assistant-choice |
| claim-computer | computer.lost | Claim only if this loss is still the latest lifecycle event and its personal owner has not been removed. | backfill-lifecycle |
| confirm-ownership | ownership.transferred | Confirm an active successor once on its member stream. | ownership-coordination |
| seed-ownership | silo.owner_bootstrapped | Read current members and existing ownership before seeding. | ownership-migration |
| seed-model-grants | member.joined | Skip removed members; keep later grants and revocations. | grants-backfill |
| seed-model-grants | silo.owner_bootstrapped | Skip removed owners; keep later grants and revocations. | grants-backfill |
| seed-model-grants | assistant.created | Check the personal owner's membership; keep later revocations. | grants-backfill |
| seed-provider-default | provider.verification_recorded | Keep a saved binding or pause; use only the first verified default. | provider-bindings |
| seed-provider-default | provider.models_selected | Keep a saved binding or pause; use only the first verified default. | provider-bindings |
| stop-budget-turns | budget.ceiling_set | Require the conversation index through the stop; keep saved Stop and final reports. | budget-stop-handler |
| stop-budget-turns | budget.exhausted | Use the admitted payer and position; keep one stop per unfinished turn. | budget-stop-handler |
| settle-budget | computer.lost | Require the latest lifecycle event and reservations saved before it. | actor, loss-backfill |
| settle-budget | effect.observed | Read current spending and all saved effect amounts; charge once. | reconcile |
| settle-budget | effect.resolved | Read current spending and saved resolutions; charge once. | reconcile |
| update-openfga | routine.created | Keep a later applied transfer or retirement; legacy records grant no access. | routines |
| update-openfga | routine.reassigned | Keep a later applied transfer or retirement; replace the recorded owner. | routines |
| update-openfga | routine.retired | Keep permitted metadata readers and remove management. | routines |
| update-openfga | member.joined | Keep later applied membership and ownership changes. | projection |
| update-openfga | silo.owner_bootstrapped | Keep later applied membership and ownership changes. | projection |
| update-openfga | member.role_changed | Keep later applied roles, removals and ownership changes. | projection |
| update-openfga | member.removed | Keep a later applied rejoin. | projection |
| update-openfga | ownership.seeded | Keep later ownership changes or applied member removals. | projection |
| update-openfga | member.ownership_confirmed | Keep later step-downs and removals; override generic role edits. | ownership-coordination |
| update-openfga | ownership.transferred | Check authority at the saved transfer; keep later changes for its recipient. | projection |
| update-openfga | ownership.stepped_down | Keep later changes for that owner or an applied member removal. | projection |
| update-openfga | team.created | Save only a receipt; create no membership. | projection |
| update-openfga | team.member_added | Keep a later applied removal for that member. | projection |
| update-openfga | team.member_removed | Keep a later applied addition for that member. | projection |
| update-openfga | grant.given | Keep a later applied revocation for that grantee and kind. | projection |
| update-openfga | grant.revoked | Keep later grants; check each kind separately for older removals with no kind. | projection |
| update-openfga | participant.added | Keep a later applied removal for that participant. | projection |
| update-openfga | participant.removed | Keep a later applied addition for that participant. | projection |
| update-openfga | conversation.created | Add its silo link; skip participants whose later removal was applied. | projection |
| update-openfga | assistant.created | Keep its immutable owner link independently of membership. | projection |
| update-openfga | provider.created | Keep its immutable silo link and event receipt. | projection |

Test names refer to files in `apps/ops/test`, `libs/models/test` or `libs/authz/test`,
with `.test.ts` added. `libs/handlers/test/upgrade.test.ts` checks job receipts,
subscription changes, parked jobs, resume, timeouts, locks, connected sessions,
failed-job reports, cancellation and ordering with live jobs. It also checks
incompatible resume records, foreign-silo history, retry exhaustion and SIGKILL
inside a chunk, inside final publication and just after publication commits.
The worker process check is `apps/ops/test/worker-subscriptions.test.ts`. Million-event throughput and
fresh-install upgrade qualification are NOT RUN.

Keep event-id receipts for retained external state. Workers check these receipts
before invoking reactions, including newly subscribed historical events. External
services still need their own event-id idempotency rule for a crash before the SQL
receipt commits. Restart decision services and handlers first, check that jobs
finish and permissions catch up, then restart clients and other event writers. Live upgrade qualification
on a customer installation is NOT RUN.

Run `PG_TEST_URL=<PostgreSQL admin URL> npm test -- libs/handlers/test`.
The selected database is only a control database and the role needs `CREATEDB`:
each test creates and drops an isolated, randomly named database, so test files
can run in parallel. `pretest` fetches real NATS; PostgreSQL tests skip without
the URL and are then NOT RUN. See [evidence](evidence.md) for results and limits.
Upgrade tests keep pool connections open until they close idle clients themselves.
They wait for those clients' PostgreSQL backend PIDs to disappear before starting
an exclusive upgrade. Deliberately checked-out clients stay open for refusal tests.
The fixture pool uses `application_name = handlers-test-fixture`. Crash children use
`handlers-crash-<mode>`; the parent waits for their connections to disappear after
SIGKILL. The checks use the separate control database and stop after 15 seconds.

Fresh Kubernetes/R3 failover, PostgreSQL failover, external effects, OpenFGA,
operator UI/alert routing and durable log export remain NOT RUN.

Runtime licences checked: pg-boss 12.35.0, cron-parser 5.10.1, luxon 3.7.2,
non-error 0.1.0, pg 8.23.1, rrule-temporal 2.2.7, serialize-error 13.0.2 and
tagged-tag 1.0.0 are MIT; temporal-spec 1.0.1 is Apache-2.0; type-fest 5.10.0
uses its MIT option. Existing NATS, events, projections and observability
libraries retain their licences. Runtime image inventory is NOT RUN.
See [ADR 0004](../../docs/adr/0004-handler-runtime.md) for the spike limits.

Use the `dispatcher` NKey seed, TLS files and `connectNats()` from the event-store
package (or `connectEventStore()` for a projection source). Required file paths
and NATS permissions are defined in [ADR 0005](../../docs/adr/0005-nats-access.md).
Never supply the command identity to a reader process.

Consumer creation/reset belongs to the authorised provisioning job, following
[ADR 0005](../../docs/adr/0005-nats-access.md); dispatchers bind the existing durable consumer; projections read exact sequences.

## Conversation job keys

`update-openfga` keys creation and participant changes by the checked conversation
id (`conversation-<id>`), retaining creation's key. Other handlers keep subject keys.
Live enqueue, historical batch enqueue and worker validation use `handlerJobKey`
for exact current and legacy subjects. The real PostgreSQL and NATS checks in
`test/conversation-jobs.test.ts` cover historical creation, removal and re-addition
in saved order. `libs/authz/test/conversation-order.test.ts` holds creation open
while removal is queued, then checks permissions and a complete OpenFGA rebuild.

Before upgrading, stop writers and dispatch. Drain queued and running IAM jobs with
the old worker; repair and retry failed jobs first. Stop that worker, deploy worker
and dispatcher together, then resume. Never run old `participation-<id>` keys beside
new conversation keys. If draining is impossible, rebuild permissions and execution
state together from the whole ordered event log using the recovery procedure above.
Never requeue old joins after newer removals. Live upgrade qualification is NOT RUN.

New owners need `member.ownership_confirmed`: see the [ownership contract](../../docs/api/ownership.md).

## Native nightly trigger

`runtime.startNightly(scan)` registers the plain `dream-nightly` queue and worker,
then saves `0 2 * * *`, UTC, key=silo, missed=skip through pg-boss 12.35.0.
A second pg-boss instance in the same host enables only the native timekeeper;
the original runtime still has schedule=false and handles trigger delivery.
The host calls this only after the dispatcher manifest and workers are ready.
Stopping the runtime stops both instances. Replay never calls this method.
`test/nightly.test.ts` drives TestClock and the test-only PostgreSQL session
adapter across 01:59:59 to 02:00 with two native timekeepers.

The worker receives each trigger's original `createdOn` time. It checks retained
failed triggers before scanning the new occurrence and removes a failed trigger
only after the scan succeeds. `deleteAfterSeconds=0` keeps failed jobs indefinitely.
The trigger body still contains only the silo. Startup queues a new trigger, so
restart and the next nightly delivery both recover exhausted triggers.

## Gateway publication ordering

`prepare-gateway-configuration` jobs use `gateway-config-<silo>` as their queue key,
including historical jobs created by the subscription upgrade. Server streams stay separate.

Connection cleanup uses the normal retry queue and fixed error text, with no per-event
logging. It has no exhaustion callback: failed originals and material remain available
for retry or bounded maintenance. No cleanup result changes connection authority.
