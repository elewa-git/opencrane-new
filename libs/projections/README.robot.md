# Projections

For people, read [README.md](README.md) first.

`@opencrane/projections` turns ordered events into disposable PostgreSQL
content. It owns the query/transaction port, node-postgres and PGlite
adapters, the checkpoint runner, the members read model and the MCP catalogue.
Authorisation and reactions belong elsewhere; replay never sends mail,
changes OpenFGA or performs other external effects.

The conversation table has an index on `silo` and event `type`. The server uses
it to read created and closed chats in one query when it polls for work. Two partial
indexes support source-message lookups by message id within one silo and conversation.
Callers check chat permission first and confirm the matched position in the event log.
`listOpenConversations` also returns closed agent sessions, so the bridge can
check their saved work after a restart. It still omits closed human chats. The
projection only selects candidates; the bridge checks events before cleanup.

`Db.lock` accepts optional `{timeoutMs, signal}` settings. The timeout bounds both
pool acquisition and the advisory-lock wait. A cancelled or expired acquisition destroys
its connection, including one that arrives late from the pool. Bounded acquisitions use
at most 100 ms per PostgreSQL lock wait, so the server notices a disconnected waiter.
The full acquisition deadline does not restart between waits. The callback keeps its
connection until its work stops; cancellation does not release an active callback's lock.
Memory commands use 100 ms; projection workers without options retain their existing wait.
The requested lock timeout stays set during the callback and is reset before the
connection returns to the pool. The callback's `query` accepts a deadline and uses
the same checked-out connection.
A failed unlock destroys the connection. The shared connection helper limits ordinary
pool connection waits to one second. Memory keys expose `status(identity)` without creating
a key: it distinguishes missing custody, an available key and a destroyed-key marker.

`delegations` fills `delegations` and `computer_delegations` using the ordinary
checkpoint runner. The tables keep the full checked start data, original event ids,
global positions and first terminal outcome. Root and parent indexes support task
reads; computer roots are indexed by silo, assistant and generation. Legacy rows
have no root or parent index entry and grant no authority. The projection does not
verify native ancestry, issue tokens, reserve money or spawn work.
`ProjectionRunner.rebuild(delegations)` rebuilds both tables offline with readers
and workers stopped. No online replay command or browser read route is added here.
`libs/models/test/delegations.test.ts` uses disposable NATS/PostgreSQL and rebuilds the existing
budget projection alongside the hierarchy, preserving 240 settled and 110 held cents.

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

Adjacent `agent.message_delta` events share one transaction, up to 64 events or
512 KiB of encoded events. A single larger event is processed alone. The runner
flushes before any other event and at the captured history boundary; it never waits
for future reply text. Every original row and position is retained. Receipts,
projection writes and the final checkpoint commit or roll back together. Duplicate
ids are checked within the group and against earlier committed receipts. The
conversation projection checks every delta, reads each chat once and inserts the
original rows together. Only its final position changes; deltas cannot change
participants, visible activity or the first close. The
checkpoint is checked again under the existing cross-process lock. Other event
types keep their separate transactions. No access or event-store append rule changes.

Every handler attempt uses observability's `runHandler`, including preparation and
the transaction commit. A reply batch uses its last event as the log reference.
Preparation still happens outside the transaction.
`test/streaming.test.ts` checks a 28,224-character reply against a fixed two-second
bound with a ten-millisecond commit delay in an in-memory PostgreSQL engine.
Separate real PostgreSQL checks cover rollback, restart and racing duplicate batches. Start telemetry in the host to obtain real `trace_id`
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
`member_identities` binds invitations and email-only joins to OIDC issuer/subject
for realtime reads. A join binding must match its human principal. Replay rebuilds it.
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

`auditTrail` stores only chosen fields in `audit_entries`. Each record has the
event time, a safe actor kind and a SHA-256 digest of the command id when present.
A human id appears only when the envelope principal matches a checked command
field. The table has `(silo, column, position DESC)` indexes for `recorded_at`,
`event_type`, `actor_id` and `outcome`, as well as its earlier link indexes.
The event type range and its index use PostgreSQL's bytewise `C` order, so a
host's language sorting cannot hide matching families. Initialisation replaces
the earlier language-sorted event type index.
`auditTrail.create` adds these four columns to older tables. Existing rows keep
null columns until `npm run replay -- audit` replays their events. Run this once
after upgrading, then use `npm run replay -- audit --verify` to compare every
rebuilt row, including the new columns, with the live table.

`tool.dispatch_started` and `tool.dispatch_recorded` use their strict event schemas.
Both join the saved request's decision. Approval references attach approval records,
but never attach another dispatch attempt. The existing metadata allowlist excludes
call text, arguments, replies, credentials and adapter binding details.
A start is a recorded hand-off, with no confirmed outcome. Recorded dispatch maps
`outcome_unknown` to `unknown`, `not_dispatched` to `not_dispatched`, and `responded`
to `recorded`. A response is not business success. Generic gateway evidence cannot
override the saved dispatch outcome. A saved start without a dispatch outcome stays
`unknown`, even when a generic effect reports success. Starts refresh the stored
outcome used by filters, including when generic evidence arrived first. Rebuilds
apply the same rule. Neither event invents a reservation or settlement.

Existing installations must run `npm run replay -- audit` after upgrading to include
previously saved dispatch events. Follow it with `npm run replay -- audit --verify`.
The first rebuild replaces the earlier rows; verification then compares the rebuilt
rows. Replay makes no tool call and changes no event, approval or transport record.
`apps/server/test/audit-dispatch.test.ts` covers authorised reads, each outcome,
duplicate delivery, old rows, replay, access loss, isolation and bounded detail pages.
It also checks missing outcomes in both event orders and after rebuild, unrelated
starts sharing a permit or approval, Ask/Block decisions and gateway source labels.

`readAudit` reads 20 anchors by default, at most 50. Each row includes its
anchor and at most 20 related records, plus `hasMoreEvidence` when more exist.
`readAuditDetail` pages the same related records by descending event position,
including the anchor. Neither read opens the event store. Decisions and observed
outcomes stay separate. Private text, approval details, connection material,
raw arguments, destinations and gateway timestamps never enter this table.

Run `node --experimental-strip-types apps/ops/src/worker.ts audit` with the usual
projection settings. `npm run replay -- audit --verify` replays metadata under the
runner's lock in one transaction, preserving table grants and rolling back on
failure. Ordinary `ProjectionRunner.rebuild(auditTrail)` also supports drop/rebuild
with readers stopped. Neither path runs reactions. Test:
`PG_TEST_URL=… npx vitest run libs/projections/test/audit.test.ts`.

`conversationKeys(directory)` is the existing dev encrypted-content adapter shared
by the chat server and approval decision process. It stores per-conversation keys
with private filesystem permissions, exposes only key references in events, and
refuses decryption with a different silo/conversation binding. A packaged install
passes `CONVERSATION_WRAP_KEY_FILE` as the optional second argument. That file is
a 32-byte Kubernetes Secret generated in the claimed slot. The adapter uses
AES-256-GCM to wrap each new conversation key before saving it on the package's
private volume. Both processes use the same Secret. A missing, changed or damaged
wrapping key stops decryption; rotating it requires rewrapping existing keys.

The members worker also maintains the flat-group view (`groups`, `group_members`,
`group_access`). `readGroups` reads it; `rebuildGroupProjection` restores it online
without reactions. See the [group contract](../../docs/api/groups.md).

## Test dependencies

`@opencrane/projections/testing` exports the existing `database` test helper. It creates
and drops a private database per test, or a local PGlite directory. The four replay
tests that import models live under `libs/models/test` to avoid a test dependency cycle.

## Remote tool grant references

`readToolGrantReferences` selects at most 101 references for one silo and exact
server-grant subject from `inventory_inputs`. It shares model-access names and
joins, including the person's saved membership status as `membershipStatus`.
The server labels a removed person `departed` without changing the saved grant.
The query returns null membership status for groups and assistants.
The server returns at most 100 rows, using the extra row only to detect
overflow. It resolves exact event positions and decides grant/revoke and receipt
state in TypeScript. No MCP table or new projection worker is needed.

The members worker already retains typed and historical broad revokes in this
index. Its ordinary rebuild restores these references. Existing installations
need the inventory backfill described below before an empty list is complete.
`apps/server/test/integration-access-reads.test.ts` compares HTTP results before
and after member and model-access replay, including a departed person whose grant
was never revoked. Rebuilding calls no outside service.
`test/tool-grant-references.test.ts` checks the database limit and silo selection
with 102 local grants and a foreign grant on the same subject.

## Model access reads

The members worker also fills `model_access_grants` and
`model_access_assistants`. `readModelGrantRows` returns the latest saved grant event
for each model and grantee. A revoke stays in the table so old access can still be
explained. The `granted` state means a grant event was saved; it does not mean the
person is still a joined member. An old untyped revoke updates each matching
grantee kind. Typed revocations update only the named kind. The group access table ignores
revocations of person or assistant grants.

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

`agent.memory_context_recorded` stays in the event log. The conversations worker
does not put it in `conversation_feed` or advance chat metadata for it. This keeps
the internal record out of HTTP history and live WebSocket replies. Offline replay
uses the same rule.

An MCP `decision.recorded` with a `conversationId` enters that conversation's
feed with only `turnId`, `outcome`, `reason`, `requestId` and optional `callId` and
`approvalId` from `correlation.approval`. It excludes requester id, assistant id
and context digest. Model decisions keep the existing budget-refusal rule.
Conversation tool reports are copied as events in order.

`test/conversations.test.ts` uses real PostgreSQL and NATS. Dropping and
replaying `conversation_feed` returns identical rows. No backfill command is
added; the offline conversations replay command is described below.

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
has been reconciled. `discardUnpublished(identity)` removes only that revision's temporary
file when no final key or deletion marker exists. The caller must hold the fact lock and
rule out a delayed append before calling it. It never marks the revision destroyed.
Concurrent provisioning may report a store error; it cannot
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

Initial turn memory reads use `memory_facts_initial`, an index on silo, scope, kind
and memory id with PostgreSQL's bytewise `C` order. The server chooses eligible
categories and bounds each read to 33 candidates. No new projection state is added.

`memoryProjection({ decrypt })` gives ProjectionRunner read-only custody. Its optional
`prepare(event)` step returns database work after key resolution, before the SQL transaction.
The runner commits all rows, the processed id and the checkpoint together. Calling
memory's `apply` directly is refused because it would skip preparation.

`memory_facts` has a `(silo, scope_id, memory_id)` primary key. It stores current
metadata, ciphertext, key reference, event position and time. `search_text` and
`search_vector` are deletable derivatives. Search text is normalised to NFC. Older projected rows need the offline memory rebuild
to apply the new text checks and normalisation before these reads are enabled.
The TypeScript projection passes text
as a parameter to explicit `to_tsvector('simple', $14)` calls; there are no triggers,
views, generated columns or stored procedures. The order index is
`(silo, scope_id, position, memory_id)`; a GIN index supports full-text queries.
`memory_dependencies` retains same-scope links from every saved revision. Its primary key
includes the revision of the fact that used the source. Rebuild memory offline to recover
previously discarded links.
`shouldReplaceMemoryRevision` checks the existing revision before replacing a fact;
older links remain. The scanner and reference checker share this TypeScript rule.
A stale or repeated write keeps the current row and still records the saved event.
`memory_changes` stores only command, principal, fact, revision, outcome, position
and time. Its outcome is `written`, `corrected`, `quarantined` or `forgotten`, independent of key availability.
It never stores plaintext, ciphertext, keys or source payloads.

Only a destroyed key yields `unavailable`, with null search text/vector. Missing
or damaged keys and temporary custody failures stop replay without advancing that
event's checkpoint. Authenticated earlier text with C0 controls other than tab and newline
is quarantined with null search text/vector, without stopping replay. Decryption returns
this older text; write validation still refuses it. Legacy writes retain ciphertext and references as `quarantined`,
with unknown ownership and no searchable content. Parsing uses `parseEventByType`
and the full replay schema, plus `memoryIdentity` / `memoryWrittenIdentity`.
Version-1 tombstones set `content_status=erased` and clear text, vectors, sources,
ciphertext and key references for the root and all dependent facts in one transaction.
The root keeps its tombstone revision. Later writes cannot replace an erased row.
Legacy corrections, consolidation and legacy tombstones still stop replay. The server now
exposes authorised scopes and paged list/search reads.
`readMemoryFactIds(db, silo, scopeId, search?)` returns available ids in saved-event order.
Its optional search uses PostgreSQL `to_tsquery` syntax. Both paths restrict silo and
scope; callers must check permission before calling it.
Before preparation, `inspectHistory` reads metadata through the fixed position. It
follows all historical dependency links with a visited set, separately for each silo
and scope. Hidden writes skip decryption entirely. The scan retains ids and links only.
It runs before ordinary catch-up too, including after restart.
Rebuild prepares the entire saved history before dropping any tables, then prepares
each event again before its transaction. It discards each prepared result during the
first pass to avoid holding all plaintext in memory. It rebuilds only through the
position it checked. A failure during that first pass preserves live tables and
runner records. A later storage failure can still stop the second pass.
Replay never provisions or deletes keys, calls models or runs cleanup reactions.

The offline operator command is documented in [apps/ops](../../apps/ops/README.robot.md#rebuild-memory-offline).
`test/memory.test.ts` requires `PG_TEST_URL`; it uses real NATS and disposable
PostgreSQL databases. It proves operator replay equality for rows and index
settings, dependency edges, rollback, ordering, scope isolation, legacy quarantine,
destroyed versus missing/unavailable keys and key resolution before transactions.
Run it with `nice -n 10 npx vitest run libs/projections/test/memory.test.ts`.
Fresh-install customer journeys and power-loss qualification remain NOT RUN.

The [live memory worker](../../apps/ops/README.robot.md#run-the-live-memory-worker)
uses the same read-only custody as rebuild.

## Conversation participation

The projection builds `conversations` metadata and `conversation_participants`
intervals. `conversation_legacy_participation` keeps positions and event ids only for
participant events saved on the old conversation subject. It excludes modern
participation-stream events, so access readers do not point-read modern churn.
Global NATS sequences supply join and exclusive end positions; each bound
keeps its event id. Creation starts the initial intervals. Duplicate active joins and
absent removals leave intervals unchanged; re-addition starts a new interval. Current participants
have no end position. Named TypeScript functions enforce these rules, the 97-person
cap for new additions and keep closed conversations closed. SQL stores results.
Exact current and legacy subjects enter the feed by data id; participant events require creation in the same silo.
Metadata, intervals, feed and checkpoints commit together. Existing installations
need an offline conversations rebuild. Startup refuses saved creations with empty
metadata or participant tables, or a missing legacy-reference table beside saved
participant changes, and names the command:
`npm run replay -- conversations --confirm-conversations-stopped`. Stop readers and
workers before running it. Replay takes the projection lock and replaces the feed, metadata,
participation, legacy-reference and list-state tables. It resets event ids and the checkpoint,
increases the generation and replays the log.
A failure may leave a rebuilt prefix; keep readers stopped and rerun. It runs no
reactions and does not offer `--verify`. The server filters group history using the caller’s latest join position.

Inconsistent events stop the projection and leave that event's changes and checkpoint
uncommitted. The runner logs an apply failure with its event id and subject. Existing readers
cannot check a quarantine marker, so skipping a bad event could expose incomplete
access history. Safe per-conversation quarantine must wait for every read path to
refuse a marked conversation. Storage errors and event-log gaps also remain failures.

The providers runner also writes `model_bindings`, keyed by silo, kind, dependant and task. Binding events retain the configuration revision. Provider rebuild compares and switches both tables together without reactions. Existing installations initialise the new table before replaying providers.

`listConversations` accepts an optional member id to select projected current participants.
These rows are candidates; the server still checks events and OpenFGA before returning them.

File list reads accept an inclusive join position and query only records at or after it.
They return upload details, status, delivery outcome when present, and generated workspace
paths. PDF uploads also include the text path. The private `objectKey` stays out of each
returned row. Invalid saved upload data makes the read fail.

Member/Admin changes on an Owner keep its role and record a receipt. See the
[role contract](../../docs/api/members.md#change-a-member-or-admin-role).

New owners need `member.ownership_confirmed`: see the [ownership contract](../../docs/api/ownership.md).

## Recorded tool failures and approval actions

The [approval API](../../docs/api/approvals.md) explains tool failure records and approval actions.

The [member API](../../docs/api/members.md#invitation-command-status-and-refusal-history)
describes how invitation refusal records are rebuilt without granting access.

`conversation_list_state` stores JSON choices under silo/member/conversation/join event id.
Missing choices mean archived false and read position zero. Each choice keeps its event,
command and global position; read advances keep the checked target id and maximum position.
The worker checks the join and target row in the same silo, including its exclusive end.
Old join choices remain private and never apply to a new join. Preferences bypass the feed.
The offline conversations rebuild replaces this table too. Tests check identical choices,
unchanged feed rows and no event append during replay. No public commands ship here.

## Shared child records

Shared-child creation starts each named person's interval. Origin and original
parent joins stay in `conversation_feed.data`; interval event ids link back to those records.
Explicit child joins and removals use the existing interval rules and offline rebuild.

`conversations.latest_activity` stores the global position of creation, the latest
visible `message.posted` or `agent.message_completed`, or the first close. Later closes
keep the first close's position. Token deltas, tool reports, turn endings, participation
and private choices do not advance it. Reports after close still enter `conversation_feed`,
but cannot advance visible activity.
`conversations.position` continues to track the latest shared feed event folded into metadata.

The first `conversation.closed` sets `closed_event_id`, `closed_position`, `closed_by`
and `closed_at` from its event id, global position, data and envelope time. These columns
are null while open. Later closes never replace them. TypeScript applies both rules;
SQL only stores the results. Live updates and offline rebuild use the same functions.
`readConversation` keeps a late `message.posted` only when its saved `authorKind` is
`human`. It skips late agent and system posts while advancing the scan position.
Startup refuses older metadata tables without all four closing columns and names the existing
offline replay command. Rebuild restores activity and closing details, and increases generation.

`libs/models/test/conversation-activity.test.ts` uses real NATS and disposable PostgreSQL databases.
It checks late token/tool/terminal reports, completed messages, repeated closes, old-table
upgrade refusal and equality of live and rebuilt metadata and feed rows. Run with `PG_TEST_URL`
set: `nice -n 10 npx vitest run libs/models/test/conversation-activity.test.ts`.
Fresh-install lifecycle journeys remain NOT RUN.

## Hosted tool review

`applyToolPolicy` records whether a hosted registration declares a startup contract
or has a saved startup refusal. Later discovery cannot remove that restriction.
Startup publication stays Pending review rather than Ready. Existing per-call
connections, including memory records without a startup contract, retain their
reviewed publication. Rebuilding the catalogue applies the same checks and starts
no process. Transport kind alone does not decide whether credentials are used at
startup or supplied for each call.
A per-call connection still needs complete definitions, checked hashes and current
catalogue dates before it can run calls.

The providers fold stores `managedCallsEnabled: true` on the connection carrying
`provider.managed_calls_enabled` on `budget-<silo>`. This does not advance its configuration revision
or replace key verification. Replay restores the marker through the same fold.
The marker applies to the silo, including after its default choice moves.

`provider.managed_calls_drain_set` stores `managedCallsDraining` on its connection
without changing its revision or verification. The latest drain event across the
silo determines admission; one connection's projected flag is not the silo mode.
Rebuild restores these records without admitting turns or touching spending.

## Destination rules

`egressGrantStream` hashes silo/scope/subject separately from host/port.
`egressPolicy` retains the latest allowed/revoked rule, actor, time, command id, event
id and global position. `readEgressRule` selects one silo and exact rule.
`egressRulesAllow` takes current rule states and requires all three exact silo/person/
assistant rules. It checks policy agreement only, not permission to send traffic.
`ProjectionRunner.rebuild(egressPolicy)` rebuilds offline with readers/workers stopped.
No replay reaction, token, worker or socket is started. Command receipt recovery reads
the event log, so a missing or behind table cannot decide whether a change saved.

## Nightly binding read table

The existing `memory` projection also fills `memory_maintenance_bindings` with the
latest checked binding data, save time and event position per silo/scope. The table update,
processed event id and checkpoint commit together through ProjectionRunner.
Binding preparation never decrypts a fact or calls any execution service. Offline
memory rebuild restores these rows with readers and workers stopped. Existing
installations add the save-time column on worker startup. Run history is stored in
`memory_maintenance_runs`.

## Control audit fields

`takeover.refused` starts its own audit row. Matching actorId and the human envelope
principal produce a verified person; its fixed reason uses the shared protocol wording.
The saved conversationId and verified actor populate conversation_id and requester_id,
so the person who attempted control can read the refusal in conversation history.
The row carries no computer or private turn identifiers. Server refusal tests compare
the real PostgreSQL projection with a full rebuild.

Takeover events start history rows even with request correlation. Records retain
computer id, generation, takeover/lease references, reviewed requester event,
affected-turn count and recorded time. Private turn ids and text are omitted.
Replay rebuilds the same rows without opening a writer or running work.

## Dated MCP catalogue evidence

The tool register keeps the before and after tool lists and their original expiry dates.
A published server without a fresh check is shown as unavailable.

`mcp.server_discovered` stores a bounded snapshot with `checkedAt` and `expiresAt`.
`mcp.tools_changed.catalogue` stores the next snapshot; replay retains the previous one.
`mcp.catalogue_checked` renews a matching digest or records a failed check.
Unchanged catalogue checks leave `policyRevision` stable. Failed checks advance it
and clear expiry, so later renewal cannot make an old approval valid again.
`mcp.dispatch_admitted` advances only `sequence`. It preserves rules, approval revisions,
check dates and lifecycle. Both the normal catalogue projection and rebuild use this fold.
Replay never performs a send.
The latest `sequence` still advances for writes.
Expiry uses the shortest discovery/page TTL, capped at 300,000 ms. Zero expires immediately.
Undated legacy records have no reviewed tools. A check cannot renew a list without
complete saved definitions and matching hashes; it needs a complete new discovery.
Descriptions, schemas and examples remain untrusted text, including in saved snapshots.

This is #48 PR 1. Watch scheduling, final dispatch permits, configuration acknowledgement
and the comparison screens belong to later rows of the accepted design.

### Durable drift holds (#48 PR 3, first part)

`mcp.tools_changed` sets `driftHeld: true` in the shared event fold. Discovery,
review, registration and unchanged checks preserve the hold. Legacy publication
cannot set `published` while held. A matching `mcp.configuration_observed` can now
clear `driftHeld` after exact review and publication, as described below.
There is no second publication path. Failed freshness checks alone can recover after
an unchanged successful check, but old approvals remain invalid.

Rebuild existing catalogue tables with `npm run replay -- mcp-catalogue --verify`
to show holds from older events. Authorisation already reads those events directly.
Normal projection and rebuild use the same rules, including repeated registration.
`test/mcp-evidence.test.ts` checks PostgreSQL reopen/rebuild and late publication.
The models dispatch and server approval tests check refused calls and late decisions.

This part does not add the bounded watch, close dispatch before a failed drift append,
cancel approvals on configuration reload, or qualify worker replacement. Those need
the remaining watch/dispatch coordination work. Configuration acknowledgement and
restoration must reuse #45 when available. Fresh-install journeys are NOT RUN.

Policy replay recalculates hashes from saved tool definitions before keeping any review
choice or renewing a check. It checks the tool count, distinct names, names inside definitions
and copied annotation flags too. `silo` and `serverId` are taken from saved event identity;
each following event must match both and its exact subject. `policyRevision` comes from
stored event positions. A matching catalogue check advances only `sequence` and dates.
`test/mcp-snapshot-security.test.ts` checks forged revisions, incomplete definitions,
wrong-server and wrong-silo renewal, changed tools and mismatched change records.

## Private survey reads

`personalSettings` runs under ProjectionRunner. `personal_settings` stores one JSON
survey per `(silo, member_id)`: generation, ordered encrypted steps, next step and
global progress position. Each step retains ciphertext, `ciphertextDigest`, key id and event/command/time/position.
The projection recomputes SHA-256 of the decoded encrypted bytes before saving progress.
Missing, malformed or mismatched digests stop the update without reading keys.
`readSurvey` returns this internal record or null; callers must check current membership
and projection catch-up before serving it. No HTTP reader is exposed here.
Edits invalidate later current answers; restart requires the next generation.
`ProjectionRunner.rebuild(personalSettings)` restores the same progress offline with
readers/workers stopped. It needs no keys and performs no outside actions.

## Exact tool review

Discovery always sets `reviewed: false`. Only `mcp.server_reviewed` can mark review.
Its choices must match saved definition and review digests. Replay applies Block immediately;
widening a mode clears publication. Unchanged catalogue checks keep `policyRevision` stable.

A changed connection or account mode clears every tool review and sets Block, even
when the tool definitions, costs and approval details stay the same. A later legacy
publication does not restore those reviews. The snapshot security tests cover both
binding changes. Their invalid mode cases start from Block and request Allow, so
connection, revision and review checks each cause a visible refusal on their own.

## Personal instance table

`mcpInstances` is an optional projection with one `mcp_instances` JSON row per silo/id.
`applyMcpInstance` is its shared TypeScript fold. `mcpInstanceId` hashes the fixed tuple
of silo, user, opaque profile, server and startup access generation, in that order.
`startupAccessGeneration` counts versions of the profile's startup access material.
Renaming this field preserves the tuple order and the calculated instance id.
The fold checks that id, exact stream, start deadline, installed bindings and every run.
A replacement run requires recorded absence of the original stopped Pod and increments
the run generation by one. Changed UID/spec or late old-run records refuse replay.
New observations must name the preceding saved sequence. Older observations without
`expectedSequence` retain their run and Pod checks.
No phase grants callable access. A late starting observation cannot undo a stop.
An `owner_stop` must name the instance owner. An `admin_stop` keeps its reason in
the owner's status. The command checks the admin role; this fold checks the saved
stop against the exact run and preceding sequence.
`ProjectionRunner.rebuild(mcpInstances)` rebuilds this table without external work.
The ops worker and replay CLI do not register this projection yet.

## Member inventory inputs

The members worker fills `inventory_inputs` in the same transaction as its event
receipt and checkpoint. Rows contain silo, exact stream name, category, recorded
link kind/id, latest event type/id and position. Every saved subject has one
stream row, including subjects outside the inventory categories. Only inventory
category stream rows advance on every event. Creation and participation changes
keep history links for each affected member. Routine and connection stream rows
record history that is unsupported.
Membership removals and grant revocations replace link rows without deleting them.
Legacy revocations retain member, group and assistant targets.
Computer ownership links come only from computer lifecycle events. View audit
events do not carry an assistant id and do not change computer ownership.

`readInventoryReferences` finds a member's recorded groups, their distinct current
people, owned assistants, grant streams and computers. Every query filters the
silo. It reads bounded rows and counts distinct people in TypeScript. It stops at
100 groups, 500 distinct people, 100 streams per category or 10,000 indexed links. Overflow returns `complete: false`; no exact total is claimed.
`inventoryCategoryPositions` lets the server check that category indexing is current
without reading category histories. Exact stream histories have a separate
10-second/10,000-record ceiling. The 20/50 browsing and 100 candidate limits remain
unchanged; this read is a complete review rather than a browsing page.

`inventory_inputs_backfill` holds version 1, its `completed` flag, a saved subject
count and the participation-category position. Creation sets `completed` false.
Event processing updates the count and position in its existing transaction.
Only a runner that reads from position one through the chosen end without a gap
or failed event sets `completed` true. An
interrupted first run followed by a restart leaves the index incomplete until a
full rebuild succeeds. Ordinary updates never set the completion flag on an upgrade index.
`inventoryIndexState` reads the marker and member generation without aggregating
all inventory rows. The final removal check uses this small metadata read. `inventoryHistoryInputs`
reads at most 10,001 indexed history links for one member, so the server can check
their latest conversation-worker receipts without reading the event log.

Existing installations must rebuild members before any review can be complete:
`npm run replay -- members`. Before replay, category maxima cannot certify the
index, absence replies are unavailable, and removal remains disabled. Known inputs
still check their permission receipts. Online replay compares the indexed rows,
then replaces the index and completed-replay marker together with member tables
and receipts.
No new worker or dependency is needed. `apps/server/test/member-inventory.test.ts` covers exact reads, pending
empty revocations, overlap, overflow, unrelated activity and online replay using
real NATS, PostgreSQL and OpenFGA. Fresh-install qualification: NOT RUN.

## Bounded conversation candidates

`conversationListCandidates` reads up to 100 current participation rows, ordered by
`conversation_participants.latest_activity` descending, then join position descending.
TypeScript folds this activity from creation, visible posted/completed messages and the
first close. Ordinary late joins start at zero; shared-child joins retain their released
history. An index supports the ordered member query. The server authorises each candidate
before displaying metadata, applying private choices or searching decrypted titles.
`conversationListRevision` reads one generation record and includes only the supplied
candidates, which the server must authorise first. It uses their activity, join, latest
participation and archive positions. Read markers and internal reports leave these
unchanged. Candidate queries also read the join time and the last participant change
through indexes, with no silo-wide aggregate scans. The server repeats the bounded
query before release and compares only allowed rows. Scans reaching 100 return an
incomplete refusal instead of positions or page counts from denied rows.
Existing installations must stop conversation readers and workers, then run
`npm run replay -- conversations --confirm-conversations-stopped` to fill participant
activity. Startup refuses the old table shape. Replay restores activity and private
choices without appending events or running reactions.

## Tombstone replay split

P4-13 PR 2 is split to respect the 600-line ceiling. This first part supports safe
projection/replay of version-1 tombstones only. No HTTP forget command, cleanup reaction,
cleanup event or completion status is enabled. Every scope's forget remains disabled.
The next part must deliver person HTTP forget, physical erasure of all revisions and
candidate keys, cleanup evidence/status and job recovery together before exposing it.

Local source tests cover pending replay without decryption, transitive and historical
links, duplicate delivery, later writes and transaction rollback. Physical key cleanup,
cleanup exhaustion, append ambiguity/lost reply, disabled model endpoint and fresh-install
HTTP forget qualification are NOT RUN in this split. Existing authority tests are unchanged.

Source receipt, 11 October 2026: code `e768ada9`, including main at `e8f25d6d`,
with failing-first test commit `f4589959`. The environment is a local Linux worktree
with a clean npm ci, real disposable PostgreSQL/NATS and test key files, not a fresh silo.
PASS: monorepo lint, workspace typecheck, check:events (121 types), Knip and lint:changelog.
PASS: changed files twice after merging main, 28 tests each; related run, 27 files / 1,156 tests.
PASS: the standalone `apps/server/test/memory.test.ts` rerun before merging main, 129 tests.
Its log is `/tmp/p4-13-memory-alone.log`.
Vitest, lint and typecheck used `nice -n 10`. The full root suite was not run.
Builder check: the late-dependency regression failed before the fix and passed afterwards.
Logs are on the builder host: `/tmp/p4-13-merged-lint.log`,
`/tmp/p4-13-merged-typecheck.log`, `/tmp/p4-13-merged-events.log`,
`/tmp/p4-13-merged-tests.log` and `/tmp/p4-13-merged-changed-{1,2}.log`.
Hosted CI could not be read with the current repository token. Live qualification is NOT RUN.

## Memory cleanup records

`memoryErasureHistory` accepts saved events as an iterable or async iterable. It returns
hidden ids from tombstones and historical dependencies without reading text or keys.
The cleanup reaction reuses this calculation. The memory projection checks and consumes
`memory.cleanup_recorded` without changing fact rows or keys. Completion evidence stays
in the scope event history; rebuilding tables never runs cleanup or calls a model.

## Nightly intent history

`memory_maintenance_runs` copies checked maintenance records in the memory runner's
transaction with its checkpoint. Offline memory replay rebuilds these rows without
a scheduler, model, tool, computer or spending port. Rebuild memory on upgrade
with readers and workers stopped to create this new table.
The shared TypeScript selector compares these reviewed references with current fact
metadata. It reads encrypted byte lengths without decrypting. SQL stores rows and
does not decide which facts are dirty. A review covers expiry through its `intendedAt`
boundary. Selection delays cannot count later expiry as already reviewed.

## Publication preparation (P3-4 PR 2a; Part of #45)

The tool-policy fold saves reviewRevision, publicationRevision and publication intent. New publication events
leave published false and advance policyRevision to their saved position. Old boolean events cannot supply a
generation entry. Rebuilding the catalogue repeats the same fold and starts no preparation.

## Gateway receipts in tool policy

`configurationObservation` holds the latest matching gateway receipt for the publication.
A new gateway process or generation refreshes it after an exact live observation.
Repeated probes recover the same receipt. The status read still matches every receipt
field to the current gateway observation; it never accepts an old process as current.
The fold checks its publication change, fragment digest, review and source position.
Receipt events preserve policyRevision. Changed policy or publication clears the field;
unchanged checks and dispatch admission keep it. The catalogue stores it in the existing
policy JSON, without new columns. Rebuild repeats this fold without probing or writing
configuration, and cannot establish live readiness.

## Hidden child requests

`conversation.child_requested`, `conversation.child_start_failed` and
`conversation.child_retry_requested` are skipped before
the conversation feed is written,
like `agent.memory_context_recorded`. Rebuild repeats that omission. The separate
child creation still rebuilds its recorded participants and OpenFGA receipts.

### Acknowledged restoration (#48 PR 3c)

A receipt must name the current publication intent's review as well as the current
policy review. It enables a first publication or restores a held publication only
if the evidence is fresh at observation and event time. Old, duplicate and superseded receipts cannot
restore a later drift. The existing delivery helper checks exact gateway generation
and digests before writing this receipt. The fold does not probe a gateway during replay.
A failed check clears expiry and advances the approval revision. It preserves the saved
publication, acknowledgement and any existing drift hold. An unchanged successful check
restores freshness without reviving old approvals. The retained receipt keeps the exact
review current across check failures; other policy changes clear it. Actual tool changes
still need another exact review, publication and live receipt.
The live watch starts closed after restart; rebuilt tables alone cannot authorise a send.

Existing installations affected by a failed catalogue check need an MCP catalogue rebuild
with `npm run replay -- mcp-catalogue --verify`. Replay restores the acknowledged publication
only when later events left its reviewed definitions unchanged. The models watch must still
complete a fresh capture, and sends still need a current live gateway acknowledgement.

## Hosted image admission receipts

`mcp.image_checked` and `mcp.image_check_requested` advance tool-policy sequence only. It preserves policyRevision,
publication, catalogue dates and discovery state. Catalogue replay uses the same
fold, starts no work and appends no event. Admission expiry is derived by models
from the original event dates when read, without a timer or database business rule.

## Publication status records (Part of #45)

The existing MCP catalogue worker now copies publication requests, withdrawals,
gateway requests and observations into `mcp_publication_records`. Registration rows
keep only serverId and kind, alongside the original command id and event type.
The table contains no endpoint, review text or route content. Its two indexes support
original-command lookup and the latest event of each type on exact subjects.
Catalogue rebuild and verification include the table and replace it atomically.
Existing installations need a catalogue rebuild before status reads are available.

`readPublication` uses one PostgreSQL snapshot for the policy and latest records.
Ready requires `isToolPolicyAvailable`, the same check used by the chat bridge,
as well as the current generation, reviewed record and fragment digests, source
position, process reference, configuration digest and observedAt to match. A later
withdrawal is Disabled. Missing preparation or observation stays Applying. After
30 seconds from the saved gateway request, missing observation or receipt is Unknown;
this is a status deadline, not proof of delivery failure. Failed reads and reads taking
more than ten seconds return Unknown with fixed stage/reason values and no error text.
A rejected file has no saved rejection event: it remains at `observation/not_observed`,
never a fabricated rejection diagnosis. GET never repairs or probes it.
Replies contain only status, stage/reason, generation, changeRef, digests and safe dates.
These are saved observations, not a new process health check or permission to call tools.
The catalogue row also derives Ready from `isToolPolicyAvailable`; an earlier lifecycle
label cannot hide a newly acknowledged policy. Both the person and assistant still need
current grants when tools are offered or called.

Existing installations affected by the first-publication defect need an MCP catalogue
rebuild. Replaying the original matching receipt repairs the saved policy without
creating a new publication or changing grants. The bridge continues to read current
events and refuses an unpublished, withdrawn or changed policy even while the catalogue
projection is behind. `apps/server/test/integration-publication.test.ts` covers the
fresh order, replay, withdrawal, stale generations, expired evidence and both grant sides
with real NATS, PostgreSQL, OpenFGA, gateway and WebSocket fixtures.
Fresh-install live qualification after this correction remains NOT RUN.

## Reload approval revisions

`publicationRevision` records the saved publication position. `isToolReviewCurrent`
accepts either an unchanged review or that exact publication's approval invalidation.
Other policy events clear this position or advance `policyRevision` past it. Failed checks
keep the review only when the exact publication was already acknowledged. Receipt and
status checks use the same rule.
A replacement publication holds a previously callable server until its exact live receipt.
An intent with a stale source position or review cannot retain the reviewed authority.
Rebuild repeats these decisions without configuration writes or upstream calls.
Rebuild the MCP catalogue on upgrade so earlier publication events gain this position.

## Unfinished child requests

`childRequests` is a separate projection filled by the conversations worker. It records
only silo, parent, request and intent id/position, child id, first-input id and failure references.
The name `child-requests-v4` and table `child_requests_v4` force an upgrade replay.
Failure events mark the matching intent. A retry clears only its named failure at the next
attempt; recovery reads only unfailed rows. First input keeps the candidate queued.
Only activation with matching silo, parent, child, request, intent id/position and first-input id
removes it. The event schema also checks the child subject and server writer. The index
supplies candidates, never permission or proof that a stage can run. It does not write a conversation feed row or contain source text.
Stop the conversations worker and server readers before `ProjectionRunner.rebuild(childRequests)`.
Replay performs
only database writes. A new installation or upgrade builds this separate index from
position one; it does not require rebuilding other conversation tables.

## Closed conversation display reads

`readConversation` reads the feed boundary, first close position and generation in
one query, then scans only through that boundary. It returns up to 100 visible rows.
TypeScript hides `agent.*` rows and duplicate closes after the first close; SQL
only selects rows. Each scan resumes after its last examined position, including
hidden rows, with a ten-second loading limit. Human posts retain their positions.
The existing `position` reply is the captured boundary, not a read acknowledgement.
A full page continues from its last returned row. A shorter page has scanned the
boundary completely. Raw reports and first-close metadata remain replayable.

## Memory corrections

Version-1 corrections share the current-value projection. `memoryErasureHistory`
returns superseded revision bounds separately from permanently hidden fact ids.
Historical links to replaced revisions hide dependent facts transitively. Replay skips
superseded decryption and keeps outgoing links from every revision. Rebuild offline
before serving existing corrected histories; replay itself changes no keys.

## Native request refusal audit records

`agent.native_request_refused` stays in the event log. The conversation
projection skips it before inserting chat rows, just like private memory records.
Rebuild repeats that omission. The server regression projects a real NATS event into
PostgreSQL, then reads messages through HTTP and the socket, with and without replay.
The volume regression projects the refusal before seeding its large message batch.

## Declared tool costs and approval details

Both Allow and Ask require `costCents: 0` and saved `review` details in exact review
and later mode changes. Block remains available when either is missing. Discovery
never marks review. Existing definition and review digests detect metadata changes;
`mcp.tools_changed` holds the whole server, including unchanged siblings. Unchanged
catalogue checks preserve the review and policy revision. Replay uses the same checks.
Older exact Allow reviews without approval details remain readable during replay,
but all their tools become unreviewed Block and publication is cleared. The fold still
checks their original digests, connection, account, reviewer and dates. New review
commands refuse the incomplete choice before appending it.

## Request deadlines for database reads

`Query.query` accepts an optional third argument, `{ deadline }`, measured with
`performance.now()`. The PostgreSQL pool adapter bounds connection waiting and sets
`statement_timeout` to the remaining time inside a separate transaction. A successful
query commits and clears the local setting. A failed query destroys its connection,
which rolls back the transaction. Ordinary projection writes keep their existing path.
The spending choices route supplies the same deadline for checkpoints, candidates and caps.
The route tests hold exclusive locks on all three tables and require a reply before
releasing the lock, then check that a later request succeeds.

## Routine records and offline replay

`routines` uses `ProjectionRunner` and the strict event parser with `foldRoutine`.
`routines` stores current facts and their last event id and position.
`routine_occurrences` stores each due with its frozen definition, activation, Stop
request and first terminal result. It retains the due event id/position and terminal
reference. Late records must match the original run even after later runs finish.
Skipped dates and missed ranges are single rows. A missed range is identified within
its silo/routine by schedule revision and first/last local dates. It is never expanded.
Legacy facts remain `legacy-needs-migration` with `executionAvailable: false`.
Instructions remain ciphertext; projection and replay accept no decryption port.

`rebuildRoutineProjection` holds the runner lock and uses the ordinary runner inside
one PostgreSQL transaction. Drop/create, receipts, checkpoint and generation roll back
on interruption. `verify` compares all rows at the live checkpoint before catching up
to the captured event position. Keep readers and workers stopped until commit.
Tests: `PG_TEST_URL=… nice -n 10 npx vitest run libs/projections/test/routines.test.ts`.
They use real NATS/PostgreSQL and guarded worker/replay child processes.
Fresh-install live qualification is NOT RUN.

## Child activation records

`conversation.child_activated` is excluded before conversation feed insertion, list
updates and notifications. Replay uses the same exclusion. The v4 recovery index keeps
saved first inputs queued and retires them only when matching activation is saved.

## Role and ownership audit facts

Role changes retain memberId, previousRole and newRole. Ownership operations distinguish
`transfer_intent`, legacy `appointment`, `ownership_confirmation` and `step_down`.
Confirmations keep appointmentId. Appointments and confirmations record the new Owner
role; intents do not claim a role change. Step-down records the known Owner-to-Admin change.
These facts do not claim that the current member still has that role. Person attribution
still needs a matching human principal. Confirmation reactions remain system actors.

`readAuditOwnershipConfirmation` uses a silo-bound appointment index and reads at most two
records. It also matches the affected member and requires a later position. Missing or
conflicting confirmations cannot prove progress. Run `npm run replay -- audit` after this
upgrade, then `npm run replay -- audit --verify`. Replay never stores live progress.

## Member removal history

`member.removed` adds `operation: remove` and the affected `memberId` to audit metadata.
The existing reason allowlist supplies safe wording; unknown reasons become
`Recorded reason withheld`, and an absent reason stays absent. The original event time
and command digest remain unchanged. A person is attributed only when `removedBy`
matches the human principal. No email, display name, invitation, review inventory or
cleanup state is copied. Existing installations need audit replay to add these fields
to previously saved removals. Replay runs no removal or cleanup reaction.

## Member admission history

`member.joined` adds `operation: join`, the affected `memberId`, the saved `role`
and optional `invitationId` to audit metadata. Each admission retains its own event
time and command digest. Older joins without invitation references invent none.
No email, sign-in identity, credential or private inventory is copied. The join
command's human principal is an SSO subject, not a verified member id. Its audit
actor therefore remains `unverified`, even if those strings happen to match.
System and agent actors remain separate from people.

Run `npm run replay -- audit` after upgrading to fill older audit rows, followed
by `npm run replay -- audit --verify`. Rebuild restores facts only. The server
checks current receipt progress separately; replay runs no admission, invitation,
provisioning or grant reaction.
