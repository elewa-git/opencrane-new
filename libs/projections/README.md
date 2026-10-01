# Projections

`@opencrane/projections` turns ordered events into disposable PostgreSQL
content. It owns the query/transaction port, node-postgres and PGlite
adapters, the checkpoint runner and the first members read model.
Authorisation and reactions belong elsewhere; replay never sends mail,
changes OpenFGA or performs other external effects.

The public entrypoint is `src/index.ts`:

```ts
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, pgliteDb, members } from '@opencrane/projections';
import { PGlite } from '@electric-sql/pglite';

const engine = new PGlite();
// store is an initialised EventStore for this silo.
const runner = new ProjectionRunner(pgliteDb(engine), store, createLogger('members'));
await runner.initialise(members);
await runner.run(members);
await runner.rebuild(members);
await engine.close();
```

For PostgreSQL, pass an owned node-postgres `Pool` to `pgDb(pool)`. The caller
configures TLS, handles pool errors and closes the pool after stopping the
runner. Each transaction checks out one client; failed work rolls back.

There must be one active runner per projection and database. A handler
writes only through its supplied transaction and must not make external
calls. Each event's handler writes, processed-event id and checkpoint commit
together. Errors propagate and stop the drain; callers may retry with
`run(projection, { attempt: 2 })`. There is no automatic poison-event skip.
`run` drains to the head captured on entry, from the stored global checkpoint.
The source must provide every event in global order; filtering is a handler
concern in this slice. Poll or call again for later events. An abort stops
between transactions; an already running transaction may finish.

Every handler attempt uses observability's `runHandler`, including the
transaction commit. Start telemetry in the host to obtain real `trace_id`
values; the helper deliberately omits that field with a no-op tracer.

`rebuild` drops/recreates only the supplied projection's tables and resets
its event ids/checkpoint in one transaction, then replays from the start.
Stop readers and runners before this destructive operation. For an online
rebuild, provide shadow tables and a separate projection name, catch up and
switch readers in the host. An interrupted replay resumes from its committed
checkpoint. `initialise` must precede `run` or `rebuild`.

The members table uses `(silo, member_id)` as its key. Invitations are
`invited`, acceptance replaces details and marks `joined`, removal marks
`removed`; role changes update the role. Pending and removed rows grant
no rights. `member_changes` stores each resulting row with its event-log position;
`member_identities` binds invitations to OIDC issuer/subject for realtime reads.
These tables, member rows and checkpoints share the same transaction. `pg_notify`
is called in that transaction and delivered after commit, with no SQL business rules.
`connectMemberFeed` owns a read pool and a dedicated LISTEN connection; callers
close the feed on shutdown. See the [server contract](../../apps/server/README.md#members-realtime-and-shutdown).
An existing projection needs an offline rebuild to fill these new tables.
This invitation view accompanies the catalogue's invitations
projection; invitation delivery is outside this package.

Run `sh scripts/fetch-nats.sh`, then `npx vitest run libs/projections/test`.
PGlite tests use a real on-disk PostgreSQL engine, real NATS, a failed
transaction after handler writes, reopen/resume, duplicate ids and rebuild
equality. Set `PG_TEST_URL` to a PostgreSQL admin URL whose role has `CREATEDB`
to run the same suite through node-postgres; CI supplies one. The selected
database is only a control database: each test creates and drops its own
randomly named database, so test files can run in parallel. Without that
variable PostgreSQL integration is NOT RUN. This suite does not simulate a
SIGKILL during commit. Fresh-install live qualification remains outstanding.

Licences checked at introduction: PGlite 0.5.8 Apache-2.0, node-postgres
8.16.3 MIT, and its development types MIT. Other dependencies are the event
contracts, event store and observability. See the
[event catalogue](../../docs/architecture/events.md) and
[engineering standard](../../docs/process/standards.md).

Use the `CN=projection` client certificate and `connectNats()` from the event-store
package (or `connectEventStore()` for a projection source). Required file paths
and NATS permissions are defined in [ADR 0005](../../docs/adr/0005-nats-access.md).
Never supply the command identity to a reader process.
