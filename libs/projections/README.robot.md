# Projections

For people, read [README.md](README.md) first.

`@opencrane/projections` turns ordered events into disposable PostgreSQL
content. It owns the query/transaction port, node-postgres and PGlite
adapters, the checkpoint runner, the members read model and the MCP catalogue.
Authorisation and reactions belong elsewhere; replay never sends mail,
changes OpenFGA or performs other external effects.

The conversation table has an index on `silo` and event `type`. The server uses
it to read created and closed chats in one query when it polls for work.

The public entrypoint is `src/index.ts`:

```ts
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, pgliteDb, members } from '@opencrane/projections';
import { PGlite } from '@electric-sql/pglite';

const engine = new PGlite();
// reader is an initialised EventStore using the projection NATS identity.
const runner = new ProjectionRunner(pgliteDb(engine), reader, createLogger('members'));
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

The low-level `rebuild` method is destructive and remains for tests and offline
maintenance: stop readers and runners before calling it. Operators use
`npm run replay -- members` or `npm run replay -- mcp-catalogue`, which takes the
same cross-process advisory lock as the normal PostgreSQL runner, builds shadow
tables and replaces the live contents plus the checkpoint under one ordered table
lock. The live tables keep their grants.
Changed history bumps a generation used to reset realtime cursors. See the
[operator runbook](../../apps/ops/README.md). `initialise` must precede `run` or
`rebuild`.

The members table uses `(silo, member_id)` as its key. Invitations are
`invited`, acceptance replaces details and marks `joined`, removal marks
`removed`; role changes update the role. Pending and removed rows grant
no rights. `member_changes` stores each resulting row with its event-log position;
`member_identities` binds invitations to OIDC issuer/subject for realtime reads.
These tables, member rows and checkpoints share the same transaction. `pg_notify`
is called in that transaction and delivered after commit, with no SQL business rules.
`connectMemberFeed` owns a read pool and a dedicated LISTEN connection; callers
close the feed on shutdown. See the [server contract](../../apps/server/README.robot.md#members-realtime-and-shutdown).
An existing projection needs an offline rebuild to fill these new tables.
This invitation view accompanies the catalogue's invitations
projection; invitation delivery is outside this package.

`mcpCatalogue` projects registration, discovery, rejection, publication, removal,
tool modes and tool drift into `mcp_catalogue` and `mcp_tool_modes`. Tool drift leaves
the server quarantined for review. `connectMcpCatalogue` maps those stored facts into
typed register rows; it does not guess missing catalogue metadata. Both tables can be
rebuilt online with `npm run replay -- mcp-catalogue --verify`; the destructive
`ProjectionRunner.rebuild(mcpCatalogue)` remains available for offline maintenance.

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

Use the `projection` NKey seed, TLS files and `connectNats()` from the event-store
package (or `connectEventStore()` for a projection source). Required file paths
and NATS permissions are defined in [ADR 0005](../../docs/adr/0005-nats-access.md).
Never supply the command identity to a reader process.

Projection readers do not create, reset or bind consumers. They read exact
sequences from their SQL checkpoints as defined in
[ADR 0005](../../docs/adr/0005-nats-access.md).

The MCP catalogue also stores the reviewed connection/tool revision policy. Its
TypeScript fold is shared with decision reads; SQL only stores the result.
Legacy name-only modes never grant execution. Both ordinary and online catalogue
rebuilds retain this policy; replay does not dispatch tools.

`auditTrail` stores a metadata allowlist in `audit_entries`, indexed by silo,
request, permit, approval, conversation, requester and turn. `readAudit` reads
50 indexed anchors then their relevant request/permit/approval and conversation/turn streams; it never
reads the event store. Decisions and observed outcomes remain separate, including
unknown outcomes. Private text, approval details, connection material, raw
arguments, destinations and gateway timestamps are excluded at projection time.

Run `node --experimental-strip-types apps/ops/src/worker.ts audit` with the usual
projection settings. `npm run replay -- audit --verify` replays metadata under the
runner's lock in one transaction, preserving table grants and rolling back on
failure. Ordinary `ProjectionRunner.rebuild(auditTrail)` also supports drop/rebuild
with readers stopped. Neither path runs reactions. Test:
`PG_TEST_URL=… npx vitest run libs/projections/test/audit.test.ts`.

`conversationKeys(directory)` is the existing dev encrypted-content adapter shared
by the chat server and approval decision process. It stores per-conversation keys
with private filesystem permissions, exposes only key references in events, and
refuses decryption with a different silo/conversation binding. Production secret
custody remains a deployment qualification responsibility.

The members worker also maintains the flat-group view (`groups`, `group_members`,
`group_access`). `readGroups` reads it; `rebuildGroupProjection` restores it online
without reactions. See the [group contract](../../docs/api/groups.md).

## Computer state for chat

The `computers` projection stores `chat_state`, `recovered` and `lost_at` alongside
its existing lifecycle status. TypeScript applies the lifecycle rules. Suspended and
resumed computers are starting. A loss stays recovering through the next claim until
ready arrives. That ready marks recovery; a later claim, suspend, resume or retirement
clears the marker. The last loss time remains available for the browser's comparison.

Existing installations must rebuild the computers projection before serving the updated
chat routes. Adding the columns alone does not fill them from older events.
The chat list joins assistant kind from this table in its existing list query.
The server reads one computer record per changed chat feed, without lifecycle-history reads.
`test/computers.test.ts` checks cold resume, recovery and replay with disposable PostgreSQL.
