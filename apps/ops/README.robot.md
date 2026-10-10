# Operator replay

For people, read [README.md](README.md) first.

`@opencrane/ops` rebuilds the `members`, `groups`, `providers`, `model-access`,
`mcp-catalogue`, `computers`, `budgets`, `audit`, `conversations` and `memory` PostgreSQL
projections or the `openfga` authorisation projection from the silo's complete
`EVENTS` stream. The replay entrypoint never publishes events or runs reactions. Run it from the
repository root on Node 22.

## Delegated task worker

`npm run worker -w apps/ops -- delegations` fills the delegation and computer-root
tables using only the projection reader settings and `DATABASE_URL`. It runs no
reactions. Offline rebuilding is available through `ProjectionRunner.rebuild(delegations)`
with readers/workers stopped; `npm run replay -- delegations` is not supported yet.

## Inspect without changing state

Set the projection reader's `NATS_URL`, `NATS_CA_FILE`, `NATS_CERT_FILE`,
`NATS_KEY_FILE`, `NATS_NKEY_SEED_FILE` and `NATS_INBOX_PREFIX`, then validate
that every global sequence through the reported stream head can be read:

```sh
npm run replay -- members --dry-run
npm run replay -- mcp-catalogue --dry-run
npm run replay -- model-access --dry-run
npm run replay -- computers --dry-run
npm run replay -- budgets --dry-run
npm run replay -- audit --dry-run
npm run replay -- conversations --dry-run
npm run replay -- memory --dry-run
npm run replay -- openfga --dry-run
```

Dry-run prints the event count and changes nothing. A sequence gap, an early end
or an unavailable stream exits non-zero. The configured NATS identity needs read
access to the `EVENTS` stream but never publish access. Missing history is refused
after a one-second idle bound rather than waiting indefinitely.

## Rebuild PostgreSQL projections online

Set the same NATS reader settings and `DATABASE_URL`, then run:

```sh
npm run replay -- members --verify
npm run replay -- mcp-catalogue --verify
npm run replay -- model-access --verify
npm run replay -- computers --verify
npm run replay -- budgets --verify
npm run replay -- audit --verify
```

Audit replay rebuilds its metadata in a single transaction under the runner lock,
without shadow tables or reactions. It preserves the table and its grants; failure
rolls back both data and checkpoints. Run its worker with `node
--experimental-strip-types apps/ops/src/worker.ts audit`.

The normal projection runner and the tool share a PostgreSQL advisory lock. The
tool replays the selected projection into shadow tables, compares them with the
incremental tables at their checkpoint when `--verify` is present, catches up to a fresh stream head,
then locks its tables in reader order and replaces their contents and the
checkpoint in one transaction. Keeping the live table objects preserves their grants.
Readers may wait briefly but cannot see partial state. A repair that changes state bumps
the projection's generation, so readers reload; members
WebSocket subscribers restart from position 0. An equal verified rebuild does not. Events appended after the captured head are
processed by the normal runner after the switch. A replay error drops the shadow
tables and leaves the live projection and checkpoint untouched.

Use a PostgreSQL role allowed to create and drop shadow tables, replace the live
projection contents and take advisory locks. Run only the upgraded projection runner: an
older writer does not take the lock and is unsafe during this operation.

## Run the live memory worker

`npm run worker -w apps/ops -- memory` maintains the current memory and search tables.
Set `DATABASE_URL`, the projection-reader NATS settings and `MEMORY_KEY_DIRECTORY`.
The existing key directory needs mode 0700 and its permanent deletion markers.
As with rebuild, only `decrypt` is passed to the projection. It never creates or deletes keys.
The runner creates the `memory` checkpoint and tables before consuming saved events.
An empty installation can therefore serve `/api/memory/scopes` without any facts.

When `MEMORY_KEY_DIRECTORY` is absent, the worker logs
`Memory reads unavailable: MEMORY_KEY_DIRECTORY is not configured` once, then exits successfully.
Set the same directory setting on `apps/server` to enable memory reads. Without it, or
while a required read table is behind, routes return HTTP 503 with
`{status: "unavailable", reason: "memory_unavailable"}`. Invalid custody stops the worker
and logs the failure; restore the directory and deletion markers before restarting it.
`apps/server/test/memory-worker.test.ts` starts the real worker with disposable NATS,
PostgreSQL and OpenFGA, and checks fresh empty reads and missing configuration.

## Rebuild conversations offline

Stop conversation readers and workers, then run:

```sh
npm run replay -- conversations --confirm-conversations-stopped
```

Set `DATABASE_URL` and the projection-reader NATS settings above. The command takes
the `conversations` advisory lock and rebuilds the feed, metadata and participant
intervals through a fixed event position. It resets processed event ids and the
checkpoint and increases the generation. The normal worker refuses to start when
saved creations exist but the new metadata or interval tables are empty; it names
this command so an upgrade cannot silently miss old conversations.

Keep readers stopped until replay succeeds. A failure may leave only the successfully
rebuilt part; rerun after fixing it. Reapply any separately configured table grants
before restarting readers. `--verify` is refused; `--dry-run` only checks event history.
Replay never appends events or runs reactions.

## Rebuild memory offline

Stop memory readers and runners before this command, and keep them stopped until it succeeds:

```sh
npm run replay -- memory --confirm-memory-stopped
```

Set `DATABASE_URL`, the projection-reader NATS settings above and
`MEMORY_KEY_DIRECTORY`. The key directory must exist with mode 0700 and contain
its permanent deletion markers. The command replays the complete `EVENTS` stream
through ProjectionRunner under the `memory` advisory lock. It checks every saved
event and required key through a fixed event position before dropping any tables.
A failed check leaves rows, processed ids, checkpoint and generation unchanged.
It then drops and creates the
three memory tables, resets their processed ids/checkpoint and increases their
generation, then commits one event at a time through that checked position.
A storage failure during the second read can still leave a rebuilt prefix;
readers remain stopped and a rerun starts again. This offline command does not
preserve table grants; reapply any separately configured grants before restarting readers.
`--verify` is refused. `--dry-run` only checks complete event history; it does not
check keys or projected content. Replay never provisions/deletes keys or runs reactions.
The [projection contract](../../libs/projections/README.robot.md#memory-projection)
lists rows, indexes and focused integration proof. The server exposes scope and paged list/search reads.

## Rebuild OpenFGA offline

OpenFGA bindings are deployment configuration, so this switch has a clear
stop-the-world rule. Stop the server decision path, dispatcher and OpenFGA
workers and wait for in-flight handlers to finish. Leave NATS available; events
may continue to append. Set the same NATS reader settings, `SILO_ID`,
`OPENFGA_API_URL`, the current
`OPENFGA_STORE_ID` and, for verification, `OPENFGA_MODEL_ID`. Then run:

```sh
npm run replay -- openfga --verify --confirm-openfga-stopped
```

Without the confirmation flag the tool refuses to run. It creates an isolated
store and model, replays through the captured head and, with `--verify`, compares
the complete tuple set with the stopped incremental store. A gap, different
state or handler failure exits non-zero and deletes the new store. Each attempt uses
a preselected unique name, so a lost create response can still be cleaned up. The
run checks that exact name again after a short wait if the first cleanup check finds
nothing. If cleanup remains uncertain, the error prints the name and operator delete
command. No run deletes a store created by an earlier run automatically.

On success, install both printed ids in the server and worker configuration
before restarting them. Keep the previous store for a tested rollback window;
after the new binding is healthy, list retained rebuild stores and delete the selected
old store explicitly:

```sh
npm run replay -- openfga --list-stores
npm run replay -- openfga --delete-store <id>
```

Set `OPENFGA_API_URL`, `SILO_ID` and the active `OPENFGA_STORE_ID`. Listing prints each
rebuild store's id, name, creation time and whether it is active. Deletion refuses the
active store. Do not resume any process with one old id and one new id.

Run `npm test -- apps/ops libs/projections/test libs/authz/test` for the replay
contracts. Tests use real NATS, disposable PostgreSQL 17 databases and OpenFGA.
`PG_TEST_URL` is an admin URL; tests never use its selected database for content.
Fresh-install and multi-replica live qualification remain outstanding.

## Live workers

The `create-assistant` reaction reads the assistant choice from `member.joined`.
`personalAssistant: none` skips creation. `provision` and older joins without the
field retain the existing stable personal assistant id. The reaction checks the
member stream first and skips a late join delivery after `member.removed`.
Bootstrap also checks that the owner is still a member before creating an
assistant. Computer claims still follow `assistant.created`.
`test/assistant-choice.test.ts` uses real NATS and PostgreSQL to check repeats,
restart and SIGKILL after creation before the delivery can acknowledge completion.

`npm run worker -w apps/ops -- members`, `-- mcp-catalogue` and `-- computers` run the
projections continuously with projection-reader NATS credentials and `DATABASE_URL`.
`-- dispatcher` runs durable dispatch, OpenFGA and the lifecycle reactions. It uses
dispatcher NATS credentials for delivery and `COMMAND_NATS_*` credentials for the
single conditional appends made by reactions. `KUBECONFIG`, `KUBE_NAMESPACE`,
`TOKEN_SIGNING_KEY_FILE` and `TOKEN_ISSUER` are required; the signing key is read by
path and token values never enter events. `COMPUTER_IDLE_MS` defaults to 15 minutes.
Run one active lifecycle reconciler per silo. Commands append intent before any
Kubernetes effect; restart retries claims, modes and credential delivery from events.
The Kubernetes identity can create/get claims, get/patch/update Sandboxes, get
PVCs and checked templates, list Pods, exec in Pods and POST the Pod proxy subresource in its namespace.
It cannot read Secrets, delete Sandboxes, write PVCs or change templates or pools. Install `node infra/dev-stack/computer-admission.mjs <NAMESPACE>` before claims: fail-closed CEL policies pin the computer image and
security fields and restrict worker Sandbox writes to mode changes, claim ownership repair and the suspended-template update described below.
Kubernetes RBAC has no field-level patch permission or operating-mode subresource.
The policies cover all Pods in the dedicated computer namespace without a bypassable
label selector; install service workloads elsewhere.

The required credential sink POSTs through the authenticated Kubernetes Pod proxy to
`/credentials`. The computer atomically writes `/run/codex/computer.json` (0600, UID
1000, memory volume); Ready is appended only after delivery. The reconciler refreshes
short-lived credentials before expiry. P2-3 may read that file to supply the existing
per-thread proxy `/grant` control socket. No token value enters an event or PVC.

P2-4 now uses the shared `computerCredentials(store, tokens, silo)` check in
[libs/auth](../../libs/auth/src/credentials.ts), moved from this app so both workers
and model admission use one credential scheme. The decision process reads only
public verification keys. It checks signature, strict expiry, assistant, current
computer id/generation/token id and a matching Ready event before reservation.
A turn binds to that computer grant and its actual Codex thread (`session-id`), conversation and requester; resume
and loss revoke old grants. The model decision also checks the active turn,
personal assistant ownership and live requester membership. `-- budgets` projects
spending; `MODEL_DECISION_URL` enables the dispatcher's settlement handler.
The [gateway tests](../../libs/models/test/gateway.test.ts) exercise actual lifecycle
tokens and prove refusals leave the budget stream unchanged.
Run `LIFECYCLE_K3D=1 PG_TEST_URL=... npx vitest run apps/ops/test/lifecycle-k3d.test.ts`
for admission, ephemeral delivery, crash recovery, races, readiness and Pod/PVC loss.
Fresh-install browser and Codex-thread recovery qualification remains NOT RUN.
Provision NATS first. The processes fail on dependency errors; SIGINT/SIGTERM stops
readers, drains handler work and closes connections. The [local dev stack](../../infra/dev-stack/README.md)
supplies these settings and qualifies the processes together on real services.

`npm run worker -w apps/ops -- conversations` runs the encrypted conversation
feed projection. `ProjectionRunner.rebuild(conversations)` rebuilds it with readers
and the runner stopped; it increments the generation so reconnecting browsers
reload. No chat reaction runs during replay. Bridge delivery reads durable posted
messages, invokes the existing resume command, and waits for Ready before issuing
a turn. The idle timer accounts for pending messages and recent conversation
activity. Pod-proxy GET permission permits the server's inbound bridge WebSocket.

`npm run worker -w apps/ops -- files` runs the conversation files projection.

Server-owned `computer.turn_started` and `computer.turn_closed` events share the
computer stream with suspension. A live turn prevents suspension; competing
start/suspend commands use that stream's conditional append. An unexecuted message
whose delivery loses to suspension is delivered again after wake.

## Handler subscription upgrade

This command updates the saved list of enabled handlers and the event types they
receive. It keeps the events, queues and receipts (the saved notes that a handler
has already finished an event).

1. Preview the plan with `npm run ops -- upgrade-handlers --dry-run`.
   Dry-run takes no lock and can run while a changed dispatcher waits. It checks
   unfinished jobs and lists failed originals. If jobs are unfinished, drain them
   using the previous release before requesting another preview.
2. Stop `apps/server`, computers, the model gateway and other clients that request
   decisions or append events. Leave NATS, PostgreSQL, OpenFGA and model/budget
   decision services available while the previous release drains jobs and the
   events those reactions append. The dispatcher does not suspend computers while
   it waits on changed subscriptions; the operator stops them here.
3. After unfinished jobs finish, stop all dispatchers, workers and decision services.
   Close every other connection to the handlers database, including idle operator
   clients. The command refuses a held dispatcher lock or another database session.
   Failed originals are reported and retained; they do not block the upgrade.
4. Install the new release. Set `DATABASE_URL`, `SILO_ID` and the NATS projection
   reader settings listed above. Keep `MODEL_DECISION_URL` set exactly as it will
   be for the dispatcher: it enables `settle-budget`. `update-members` is excluded
   because the separate members runner updates those tables.
5. Apply the checked plan with writers and workers stopped:

   ```sh
   npm run ops -- upgrade-handlers --dry-run
   npm run ops -- upgrade-handlers --confirm-writers-stopped
   ```

6. Restart model/budget decision services, then the dispatcher and workers. Keep
   clients stopped while historical jobs run. Reactions may append further events.
   Check failed jobs and permissions before restarting clients and event writers.

The JSON report contains `plan`, with changed handlers, added/removed types and
matching event counts, and `failedJobs`, with original job ids, names and streams.
Dry-run changes nothing. The upgrade queues only new pairs through the saved
dispatcher checkpoint. The durable consumer handles later events after restart.
It never runs a reaction or publishes an event. Removed subscriptions and changes
to order alone skip history. Old queues and receipts are retained.

The scan saves jobs and progress in chunks of at most 256 events. It logs events
scanned and jobs queued. Transient read timeouts retry with back-off. After a crash,
the same release resumes after the last committed sequence. Jobs remain parked
until the final transaction changes the manifest and makes them available. The
checkpoint stays unchanged. A successful rerun adds nothing. Do not delete receipts,
the progress row or queues, or reset the consumer during an unfinished upgrade.
The confirmation flag records the operator's check that NATS writers are stopped;
the database lock, sessions and unfinished jobs are checked by the command.

### Failed jobs

`npm run ops -- jobs` lists failed original jobs, including their ids, handler
names, streams, retry counts and stored error output. It needs only `DATABASE_URL`.
Failures still hold later jobs on the same stream. `runtime.replay` retries an
original after its cause is repaired.

`npm run ops -- jobs --cancel <id>` deliberately cancels one failed original.
It refuses a missing id, a diagnostic copy or a job that is not failed. It keeps
receipts and records the cancellation. Later jobs on that stream can then run.
The cancelled reaction will not run unless it is queued again separately. This
is an operator decision, not an automatic response to failure.

## Model grant upgrade

With decision services and event writers stopped, use the silo's NATS command
connection environment (`NATS_URL`, TLS files, `NATS_NKEY_SEED_FILE`) and `SILO_ID`:

```sh
npm run migrate:model-grants -w apps/ops
```

This restartable migration reads existing members and assistants from
events and appends missing initial model grants. Removed members are skipped;
recorded grants and revocations are preserved. Each grant command does one
conditional append. An append conflict or outage fails the run; rerunning safely
continues. No SQL or OpenFGA state is written by this command.

The dev stack runs this command on every `up.sh` and `up.sh --fresh`, after
NATS provisioning and before decision startup. Repeated startup first stops
the server, dispatcher and model services so writers cannot race the migration.
For silos upgrading from the membership-only model, rebuild OpenFGA with the
updated model and run the handler subscription upgrade command to enable `seed-model-grants` before startup. Reactions then cover new
members and assistants. The journey checks existing members/assistants have
model grant history (including preserved revocations), and waits for new member
and assistant grants in OpenFGA before chat.
The real-gateway regression suite in `libs/models/test/gateway.test.ts` covers
fresh events, a later member, upgrade/replay and preserved revocations. A live
fresh dev-stack journey remains unqualified.

## Budget upgrade

The budget decision process repairs an existing stream with no installation
default paying group at startup under its leadership lease. It appends one
`budget.ceiling_set` with the current global daily/monthly ceilings and the
configured `DEFAULT_PAYING_GROUP_ID` (default `installation-default`). Scoped
ceilings and existing defaults are preserved. With budget writers stopped, the
same idempotent migration can run separately with command NATS credentials:

```sh
npm run migrate:budget-default -w apps/ops
```

Set `SILO_ID` and optionally `DEFAULT_PAYING_GROUP_ID`. The dev stack's `up.sh`
runs it before decision startup. Fresh empty streams are seeded by the actor.

The budget projection worker checks version 2 before resuming its checkpoint.
Older projections rebuild from event envelopes, restoring paying-group bindings
for both pending and settled reservations. It uses the same shadow replay and
atomic replacement as `npm run replay -- budgets`. Failed replay retains the
live rows, checkpoint and version so startup can retry. A changed rebuild bumps
the generation; repeat startup and an equal verified replay leave it unchanged.
Use `--verify` after upgrade to compare totals; it refuses mismatched legacy rows
without repairing them. Replay uses reader credentials and publishes no events.

## Idle polling

The computer watcher reads the whole event log once after restart, then reads only
events after its last processed position. It keeps computer history and conversation
activity in memory. These copies can be rebuilt from events.

A successful mode patch is remembered by the Kubernetes client. The same mode is
not patched again; a failed change waits before retrying. Each computer retries after
1, 2, 4, 8, 16, 32 and then 60 seconds. A successful check clears that delay. Each
failed attempt logs the computer name and the wait time. Other computers keep running. A reported suspension or a new claim
or loss event clears the remembered mode so outside changes cannot stop recovery.

Ready computers check Pod identity and renew credentials at most every 30 seconds
while the event log is unchanged. New events trigger a check on the next 250 ms
poll. Suspended computers check for outside mode changes every 60 seconds and
restore suspension when needed. Lost and retired computers wait for another
lifecycle event. Claims and resumes are checked every 250 ms until ready, unless a failed change
requires a longer wait.

Idle checks run at most once every 30 seconds, including during Kubernetes retries.
They read any new events after the Pod check so a newly posted message prevents
suspension. A pending message prevents suspension until a completed or failed turn
is recorded.

## Computer image updates

The worker asks the cluster whether a Running mode patch would pass admission.
A denied server-side dry-run means that the installed policy refuses the old template.
The worker reads `SandboxTemplate/computer` from the cluster at upgrade time. It does
not cache a template file or infer drift from that file.

A Running computer keeps its Pod until its next committed suspension. Only the
current computer generation's open turns prevent suspension or upgrade. An older
turn that never closed cannot block a newly claimed generation.

The worker updates a suspended Sandbox in place. It checks its computer and
assistant labels, the named home PVC's labels and Sandbox owner, and the absence
of a Pod. The update carries the resource version from the read and changes only
`spec.podTemplate`. It copies the checked template with that computer's identity
labels and `home-<computer>` PVC volume. Every other field stays unchanged.

One narrow worker admission rule requires the controller's current-generation
`Suspended=True`, `PodTerminated` report. It requires the exact checked Pod template,
unchanged Pod metadata, unchanged Sandbox labels, owners, annotations and finalisers,
and unchanged other spec fields. It refuses a simultaneous resume or ownership change.
A worker may suspend an old template without changing it; it may resume only a checked
one. Kubernetes RBAC gives it no Sandbox delete or PVC write permission.

Each reconciliation attempts at most one template update, then reads again on the
next pass. Computers run independently, with one active check per computer. A slow
upgrade cannot hold up another resume. A new lifecycle event skips that computer's
previous retry delay; successful work clears the delay.

Run live tests only after `infra/dev-stack/claim.sh` returns a secondary id. Set
`DEV_STACK_ID` to that id, 1 or 2. Tests verify the recorded worktree before using
`opencrane-dev-<id>`. They refuse an occupied namespace and only remove that slot's
three named admission policies. Use disposable PostgreSQL through `PG_TEST_URL`.
The image test builds and pushes a second digest under a slot-specific tag in the
local registry. It proves that v1.0.4 resumes from the updated template, with the
same Sandbox UID, same PVC UID, a new Pod UID and a saved home file.

The dispatcher registers `seed-provider-default` for provider verification and model selections. It records the first verified connection once the chat model is enabled, using current Owner/Admin authority. Redelivery retains any recorded default or pause. Restart the dispatcher with the updated subscriptions; provider replay runs no reaction.

New owners need `member.ownership_confirmed`: see the [ownership contract](../../docs/api/ownership.md).

## Destination policy table

The `members` worker also initialises and runs `egressPolicy`. It copies saved
rules and revocations only; it opens no connection to a destination. Rebuilding this
projection uses `ProjectionRunner.rebuild(egressPolicy)` offline with readers/workers
stopped. The replay CLI does not yet select this table.
