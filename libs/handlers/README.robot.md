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
observability's `runHandler` (name, event id, stream, attempt). Queue errors
are logged; dispatcher errors reject its promise and require host restart.

The durable `handler-dispatcher` consumer reads `ev.>` from the beginning,
with explicit acknowledgements and one unacknowledged message. All subscribed
jobs and a global SQL checkpoint commit together before acknowledgement.
The checkpoint row serialises overlapping dispatchers and rejects gaps,
silo mismatches and subscription changes. Registration takes a catalogue
name and handle function; subscriptions come from `libs/events`, checked
against the [catalogue](../../docs/architecture/events.md) by `check:events`.
OpenFGA's mapping is reserved; its implementation is not included.

One `key_strict_fifo` queue per handler keys jobs by stream id. Defaults:
four worker slots, five retries, exponential backoff starting at one second,
and a 60-second attempt timeout. Different streams can progress together.
The worker locks the fetched queue attempt through its SQL transaction;
handler writes and the event-id receipt commit together. Abort rolls back even
when a callback never settles; SQL calls are serialised and each statement
uses the remaining attempt time. Late callback queries are refused after
the transaction closes. Any SQL error fails the attempt even if caught. Handlers must write
only through `tx`. Receipts survive queue-job deletion. External services
need an event-id idempotency protocol of their own; this API cannot make an
external call atomic with SQL. Do not run the projection runner and this
runtime against the same projection tables concurrently.

Failed heads remain in place and block their stream. Monitor
`runtime.deadLetters(name)` and pg-boss queue errors in the host. Each failure
also has a diagnostic copy in `<handler>-dead` (14-day queued retention).
Repair with `runtime.replay(name, originalJobId)`: it retries the original
head once, preserving order. Never redrive the diagnostic copy, cancel a
head or delete it to unblock a stream. There is no automatic skip.
The pinned pg-boss adapter sets queued event jobs' `keep_until` to infinity
inside enqueue's transaction and disables finished-job deletion. This uses
pg-boss 12.35's schema; upgrades must rerun retention/replay tests. Queue rows
and receipts currently grow without pruning. Monitor database capacity.

## Recovery and subscription changes

Stop dispatchers/workers before recovery. PostgreSQL is disposable execution
state and content: rebuild it together with the consumer from EVENTS, with
external reactions disabled. Keep receipts while preserving external state.
Subscription upgrades preserve the database, consumer and receipts. They do not
rebuild projections or reset the consumer. The dispatcher holds the PostgreSQL
`handler-dispatcher` advisory lock for its whole lifetime, including when a changed
manifest leaves it waiting for shutdown. It logs changed handlers, added/removed
event types and `npm run ops -- upgrade-handlers --confirm-writers-stopped` before
waiting. The ops host starts workers and the computer watcher only after this check.

The [operator upgrade procedure](../../apps/ops/README.robot.md#handler-subscription-upgrade)
stops clients, drains old jobs with decision services available, then stops
dispatchers, workers and decision services before installing the new code. The command refuses a held dispatcher
lock and unfinished or failed original jobs. Diagnostic dead-letter copies do not
block it. A rerun with an equal manifest changes nothing, even with queued backfill jobs.

The command compares stored subscriptions with the current catalogue for the ops
host's enabled handlers. Each added `(handler, eventType)` gets historical jobs in
EVENTS order through the stored SQL checkpoint. Job insertion times keep that order
within the single transaction. Removed handlers/types get no backfill. All jobs,
the manifest and the unchanged checkpoint commit together; a failed scan rolls
back those writes. Events beyond that checkpoint stay with the durable consumer,
which sends them to all current subscribers after restart. New queue setup may
remain after failure; no reaction runs in the command. Dry-run reports each changed
handler, its added/removed types and matching historical event count without starting
the queue runtime or writing data. Counts include already receipted events.

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
Enqueue and worker validation use the same function for exact current and legacy subjects.

Before upgrading, stop writers and dispatch. Drain queued and running IAM jobs with
the old worker; repair and retry failed jobs first. Stop that worker, deploy worker
and dispatcher together, then resume. Never run old `participation-<id>` keys beside
new conversation keys. If draining is impossible, rebuild permissions and execution
state together from the whole ordered event log using the recovery procedure above.
Never requeue old joins after newer removals. Live upgrade qualification is NOT RUN.
