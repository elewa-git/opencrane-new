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

`Db.lock` accepts an optional `{timeoutMs}`. PostgreSQL resets this lock timeout before
returning the client to the pool. Memory commands use 100 ms; projection workers keep
waiting for their existing exclusive lock. The shared connection helper limits pool
connection waits to one second. Memory keys expose `status(identity)` without creating
a key: it distinguishes missing custody, an available key and a destroyed-key marker.

`delegations` fills `delegations` and `computer_delegations` using the ordinary
checkpoint runner. The tables keep the full checked start data, original event ids,
global positions and first terminal outcome. Root and parent indexes support task
reads; computer roots are indexed by silo, assistant and generation. Legacy rows
have no root or parent index entry and grant no authority. The projection does not
verify native ancestry, issue tokens, reserve money or spawn work.
`ProjectionRunner.rebuild(delegations)` rebuilds both tables offline with readers
and workers stopped. No online replay command or browser read route is added here.
`test/delegations.test.ts` uses disposable NATS/PostgreSQL and rebuilds the existing
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

Every handler attempt uses observability's `runHandler`, including preparation and
the transaction commit. Start telemetry in the host to obtain real `trace_id`
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
TypeScript checks the existing revision before replacing a fact; older links remain.
A stale or repeated write keeps the current row and still records the saved event.
`memory_changes` stores only command, principal, fact, revision, outcome, position
and time. Its outcome is `written`, `quarantined` or `forgotten`, independent of key availability.
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
Correction, consolidation and legacy tombstones still stop replay. The server now
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
Startup refuses older metadata tables without all four closing columns and names the existing
offline replay command. Rebuild restores activity and closing details, and increases generation.

`test/conversation-activity.test.ts` uses real NATS and disposable PostgreSQL databases.
It checks late token/tool/terminal reports, completed messages, repeated closes, old-table
upgrade refusal and equality of live and rebuilt metadata and feed rows. Run with `PG_TEST_URL`
set: `nice -n 10 npx vitest run libs/projections/test/conversation-activity.test.ts`.
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
latest checked binding data and event position per silo/scope. The table update,
processed event id and checkpoint commit together through ProjectionRunner.
Binding preparation never decrypts a fact or calls any execution service. Offline
memory rebuild restores these rows with readers and workers stopped. Existing
installations create the added table on worker startup. Dirty batches and run
history are not stored yet.

## Control audit fields

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
Catalogue checks leave `policyRevision` stable; policy changes advance it.
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
