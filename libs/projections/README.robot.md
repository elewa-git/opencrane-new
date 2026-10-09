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

## Model access reads

The members worker also fills `model_access_grants` and
`model_access_assistants`. `readModelGrantRows` returns the latest saved grant event
for each model and grantee. A revoke stays in the table so old access can still be
explained. The `granted` state means a grant event was saved; it does not mean the
person is still a joined member. An old untyped revoke updates each matching
grantee kind. New typed revocations update only the named kind when that event
shape is introduced.

`readModelAccessCandidates` uses keyset pages of at most 100 rows. It reads active
members from `members`, groups and their current joined-member count from
`groups`/`group_members`, and assistant ids and names from
`model_access_assistants`. It never reads conversations. The model access API
reports the oldest checkpoint among these tables so a lagging source is not shown
as current.

Run `npm run replay -- model-access --verify` to rebuild grants and assistant names
beside the live tables and switch them under the projection lock. Replay reads only
events and performs no reactions or outside calls. `apps/server/test/model-access.test.ts`
checks grant sources, revoked history, candidate pages, access refusal and replay.

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

## Tool decisions in conversation feeds

An MCP `decision.recorded` with a `conversationId` enters that conversation's
feed with only `turnId`, `outcome`, `reason`, `requestId` and optional `callId` and
`approvalId` from `correlation.approval`. It excludes requester id, assistant id
and context digest. Model decisions keep the existing budget-refusal rule.
Conversation tool reports are copied as events in order.

`test/conversations.test.ts` uses real PostgreSQL and NATS. Dropping and
replaying `conversation_feed` returns identical rows. No backfill command is
added; the operator replay command has no conversations target.

## Memory key custody

`memoryScopeId` derives scope ids; `memoryIdentity` checks saved ownership or
returns null for legacy events. `memoryKeys(directory)` provisions, encrypts,
decrypts and deletes revision keys
without returning key bytes. Its server-only file adapter requires an existing
directory with mode 0700 and writes 0600 files. It checks the directory on opening
and before every key operation. It never creates a missing directory; a lost
volume must be recovered with its deletion markers before commands resume.
AES-256-GCM uses a fresh 12-byte nonce. Additional authenticated
data binds silo, scope id/kind/owner, memory id and positive safe-integer revision.
Ciphertext stores nonce, 16-byte tag and encrypted UTF-8 bytes, in that order.

Provision publishes a synced complete key by an exclusive hard link. Delete
atomically replaces it with a synced empty file; that permanent marker cannot be
overwritten by provision. Delete also removes temporary hard links left by an
interrupted provision. Provision uses one known `-pending` filename per revision;
delete removes that file directly, without reading the directory. An unfinished
provision with no published key refuses further provisioning until the command
has been reconciled. Concurrent provisioning may report a store error; it cannot
overwrite an existing key or deletion marker.

Only an empty deletion marker decrypts to null. A missing key file is a store
error, including in an existing empty directory. Damaged key files, other file
errors and failed authentication throw. Decrypt never provisions or deletes
anything. Both encryption and decryption require a 16-byte GCM tag. Decryption
accepts 29–4,124 decoded bytes: nonce, tag and 1–4,096 encrypted text bytes.

Retain deletion markers through backup and restore. Deleted key bytes may remain
in filesystem free blocks, journals and volume snapshots until overwritten. File
deletion does not shred those bytes. Snapshot retention must follow the tombstone
rules: expire copies holding deleted key bytes under the silo's retention policy,
and reapply tombstones and deleted-key state before serving a restore.
The adapter requires a local
filesystem with atomic link/rename and file/directory fsync. Power-loss and customer
secret-store qualification are NOT RUN.

## Memory projection

`memoryProjection({ decrypt })` gives ProjectionRunner read-only custody. Its optional
`prepare(event)` step returns database work after key resolution, before the SQL transaction.
The runner commits all rows, the processed id and the checkpoint together. Calling
memory's `apply` directly is refused because it would skip preparation.

`memory_facts` has a `(silo, scope_id, memory_id)` primary key. It stores current
metadata, ciphertext, key reference, event position and time. `search_text` and
`search_vector` are deletable derivatives. The TypeScript projection passes text
as a parameter to explicit `to_tsvector('simple', $14)` calls; there are no triggers,
views, generated columns or stored procedures. The order index is
`(silo, scope_id, position, memory_id)`; a GIN index supports full-text queries.
`memory_dependencies` stores current same-scope fact/revision references.
`memory_changes` stores only command, principal, fact, revision, outcome, position
and time. It never stores plaintext, ciphertext, keys or source payloads.

Only a destroyed key yields `unavailable`, with null search text/vector. Missing
or damaged keys and temporary custody failures stop replay without advancing that
event's checkpoint. Legacy writes retain ciphertext and references as `quarantined`,
with unknown ownership and no searchable content. Parsing uses `parseEventByType`
and the full replay schema, plus `memoryIdentity` / `memoryWrittenIdentity`.
Other memory event types stop replay until their projection rules are implemented;
correction, forgetting, dependency invalidation and public reads remain later work.
Replay never provisions or deletes keys, calls models or runs cleanup reactions.

The offline operator command is documented in [apps/ops](../../apps/ops/README.robot.md#rebuild-memory-offline).
`test/memory.test.ts` requires `PG_TEST_URL`; it uses real NATS and disposable
PostgreSQL databases. It proves operator replay equality for rows and index
settings, dependency edges, rollback, ordering, scope isolation, legacy quarantine,
destroyed versus missing/unavailable keys and key resolution before transactions.
Run it with `nice -n 10 npx vitest run libs/projections/test/memory.test.ts`.
Fresh-install customer journeys and power-loss qualification remain NOT RUN.
