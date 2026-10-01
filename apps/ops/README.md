# Operator replay

`@opencrane/ops` rebuilds the `members` PostgreSQL projection or the `openfga`
authorisation projection from the silo's complete `EVENTS` stream. It never
publishes events or runs reactions. Run it from the repository root on Node 22.

## Inspect without changing state

Set `NATS_URL`, then validate that every global sequence through the reported
stream head can be read:

```sh
npm run replay -- members --dry-run
npm run replay -- openfga --dry-run
```

Dry-run prints the event count and changes nothing. A sequence gap, an early end
or an unavailable stream exits non-zero. The configured NATS identity needs read
access to the `EVENTS` stream but never publish access.

## Rebuild members online

Set `NATS_URL` and `DATABASE_URL`, then run:

```sh
npm run replay -- members --verify
```

The normal projection runner and the tool share a PostgreSQL advisory lock. The
tool replays into shadow tables, compares them with the incremental tables at
their checkpoint when `--verify` is present, catches up to a fresh stream head,
then renames the tables and replaces the checkpoint in one transaction. Readers
and WebSocket subscribers stay connected; a query may wait briefly for the final
rename but cannot see partial state. Events appended after the captured head are
processed by the normal runner after the switch. A replay error drops the shadow
tables and leaves the live projection and checkpoint untouched.

Use a PostgreSQL role allowed to create, alter and drop the members projection
tables and to take advisory locks. Run only the upgraded projection runner: an
older writer does not take the lock and is unsafe during this operation.

## Rebuild OpenFGA offline

OpenFGA bindings are deployment configuration, so this switch has a clear
stop-the-world rule. Stop the server decision path, dispatcher and OpenFGA
workers and wait for in-flight handlers to finish. Leave NATS available; events
may continue to append. Set `NATS_URL`, `SILO_ID`, `OPENFGA_API_URL` and, for
verification, the current `OPENFGA_STORE_ID` and `OPENFGA_MODEL_ID`. Then run:

```sh
npm run replay -- openfga --verify --confirm-openfga-stopped
```

Without the confirmation flag the tool refuses to run. It creates an isolated
store and model, replays through the captured head and, with `--verify`, compares
the complete tuple set with the stopped incremental store. A gap, different
state or handler failure exits non-zero and deletes the new store. If cleanup
also fails, the combined error is reported instead of hiding the orphan risk.

On success, install both printed ids in the server and worker configuration
before restarting them. Keep the previous store for a tested rollback window;
delete it through the OpenFGA administration path after the new binding is
healthy. Do not resume any process with one old id and one new id.

Run `npm test -- apps/ops libs/projections/test libs/authz/test` for the replay
contracts. Tests use real NATS, disposable PostgreSQL 17 databases and OpenFGA.
`PG_TEST_URL` is an admin URL; tests never use its selected database for content.
Fresh-install and multi-replica live qualification remain outstanding.
