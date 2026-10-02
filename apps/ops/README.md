# Operator replay

`@opencrane/ops` rebuilds the `members`, `mcp-catalogue` and `computers` PostgreSQL
projections or the `openfga` authorisation projection from the silo's complete
`EVENTS` stream. It never publishes events or runs reactions. Run it from the
repository root on Node 22.

## Inspect without changing state

Set the projection reader's `NATS_URL`, `NATS_CA_FILE`, `NATS_CERT_FILE`,
`NATS_KEY_FILE`, `NATS_NKEY_SEED_FILE` and `NATS_INBOX_PREFIX`, then validate
that every global sequence through the reported stream head can be read:

```sh
npm run replay -- members --dry-run
npm run replay -- mcp-catalogue --dry-run
npm run replay -- computers --dry-run
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
npm run replay -- computers --verify
```

The normal projection runner and the tool share a PostgreSQL advisory lock. The
tool replays the selected projection into shadow tables, compares them with the
incremental tables at their checkpoint when `--verify` is present, catches up to a fresh stream head,
then locks its tables in reader order and replaces their contents and the
checkpoint in one transaction. Keeping the live table objects preserves their grants.
Readers may wait briefly but cannot see partial state. A repair that changes state bumps
the projection's generation (members and mcp-catalogue), so readers reload; members
WebSocket subscribers restart from position 0. An equal verified rebuild does not. Events appended after the captured head are
processed by the normal runner after the switch. A replay error drops the shadow
tables and leaves the live projection and checkpoint untouched.

Use a PostgreSQL role allowed to create and drop shadow tables, replace the live
projection contents and take advisory locks. Run only the upgraded projection runner: an
older writer does not take the lock and is unsafe during this operation.

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

`npm run worker -w apps/ops -- members`, `-- mcp-catalogue` and `-- computers` run the
projections continuously with projection-reader NATS credentials and `DATABASE_URL`.
`-- dispatcher` runs durable dispatch, OpenFGA and the lifecycle reactions. It uses
dispatcher NATS credentials for delivery and `COMMAND_NATS_*` credentials for the
single conditional appends made by reactions. `KUBECONFIG`, `KUBE_NAMESPACE`,
`TOKEN_SIGNING_KEY_FILE` and `TOKEN_ISSUER` are required; the signing key is read by
path and token values never enter events. `COMPUTER_IDLE_MS` defaults to 15 minutes.
Run one active lifecycle reconciler per silo. Commands append intent before any
Kubernetes effect; restart retries claims, modes and credential delivery from events.
The Kubernetes identity can create/get claims, get/patch Sandboxes, get PVCs, list
Pods and POST the Pod proxy subresource in its namespace. It cannot exec, read Secrets
or mutate Pods, templates or pools. Install `node infra/dev-stack/computer-admission.mjs <NAMESPACE>` before claims: fail-closed CEL policies pin the computer image and
security fields and restrict worker Sandbox patches to `spec.operatingMode`.
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
A turn binds to that computer grant and its conversation (`session-id`); resume
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
