# Event store

For people, read [README.md](README.md) first.

`@opencrane/event-store` owns the JetStream adapter for the silo's `EVENTS`
stream. Commands supply an authorised, validated decision; this package
validates its event contract and performs one conditional append. It does
not authorise people or write projection state.

The public entrypoint is `src/index.ts`:

```ts
import { connectEventStore } from '@opencrane/event-store';

// NATS_URL, NATS_CA_FILE, NATS_CERT_FILE, NATS_KEY_FILE,
// NATS_NKEY_SEED_FILE and NATS_INBOX_PREFIX are required.
const { store, close } = await connectEventStore();
await store.ensureStream({ replicas: 1 }); // Local tests; production defaults to R3.
const history = await Array.fromAsync(store.readStream('member-alice'));
// Decide a command from history, then append({ event, expectedSequence }).
await close();
```

Process entrypoints call `connectEventStore(env = process.env)`, which returns
`{ store, close }` and keeps the NATS SDK inside this adapter. It does not create
or alter `EVENTS`; provision the stream separately. Call `close()` on shutdown.
`connectNats(env)` supplies the same authenticated TLS connection to the dispatcher.
Use the role-specific certificate described in [ADR 0005](../../docs/adr/0005-nats-access.md);
missing file paths fail closed and credentials in URLs are rejected.

Envelope subjects retain the catalogue's `member-alice` format. The adapter
maps the registered stream prefix to `ev.member.alice`; ids may contain further hyphens,
but no dots, whitespace or NATS wildcards. Event types must use their
registered stream prefix. Conversation and participant event data must name the same
conversation as the subject. New group creations allow at most 97 people, including
the creator. New participant ids follow the member-id format; stored events keep
the earlier parsing rules. `commandId` and `principal` are required for
appends, including an explicit system principal for system commands.
For `mcp.image_checked`, `validateCommand` requires principal kind `system` and id
`models`. Other principals return `rejected/invalid_event` before publishing.
This checks the event contract; separate process credentials remain issue #432.
New `memory.written` appends require version 1. These writes and version-1
`memory.corrected` appends share the same scope and key checks. The scope id must equal SHA-256
of JSON `[silo, scopeKind, ownerId]`. A mismatched owner, kind or silo is rejected
before writing. The key reference must equal `key:` followed by the SHA-256 hash
of JSON `[silo, scopeId, scopeKind, ownerId, memoryId, revision]`. Repeated
dependency memory-id/revision pairs are refused by the event parser before append.
Reads still parse unversioned
memory events so their unknown ownership can stay quarantined during replay.
`apps/ops/test/memory-correction.test.ts` checks real append refusals for wrong
owners and key references, unchanged history after refusal, and a valid correction.

`append` returns `appended` with the global sequence, `conflict` for a stale
expected subject sequence, `rejected` for invalid input or an unrelated
duplicate id, or `unavailable` after bounded backoff. Timeouts and server
unavailability retry for ten seconds; its history reads share that deadline.
An optional append `deadline` uses `performance.now()` and can shorten that limit.
An expired deadline stops further attempts and returns unavailable. If a retry wait
uses all remaining time, append returns unavailable after that wait even when the
timer wakes a fraction early. It never shortens the wait to squeeze in another publish.
An optional append `signal` stops retry backoff and prevents further publishes after
cancellation, including when cancellation arrives during a history read or failed publish.
Cancellation returns unavailable. It cannot withdraw a publish already sent to NATS.
It preserves the original expectation: callers reload and revalidate on
conflict. Unexpected configuration/permission/corruption errors throw with
the original cause. The `unavailable.cause` is internal diagnostic data;
HTTP callers must expose only the status. An unavailable result can be
ambiguous: retry with the same command key.

An optional `checkAccess` runs the caller's existing access check inside each append
attempt. The store samples the global log position before this check and uses the
existing conditional publish headers to require that position and the expected subject
position together. A supplied `expectedGlobalSequence` stays stricter and is not replaced.
An event saved between this check and publication produces a conflict. The caller must
reload and revalidate; this conflict is not retried internally. A failed access check
returns `unavailable` with its cause. It cannot prove whether an earlier publish with a
lost reply was saved, so callers must retain their recovery records. An expired deadline
also keeps the existing unavailable result.
The original deadline is checked again after the callback. Callers supply only the small
access-stream check, with history already read. No callback or access data enters the event.
`test/append.test.ts` covers a change between checking and publication and expiry during
checking. The production memory route covers revoked grants and disabled assistants.

Reads retry only transient unavailable errors with jittered exponential backoff
capped at 500 ms, for at most one second per NATS read. Each request keeps its
250 ms timeout.
`readEvent(sequence, deadline)` reads exactly one global position and refuses a
missing record. It lets readers check a table’s saved event number against the log.
`readStream(subject, fromSequence, deadline)` and `head(subject, deadline)` accept
an absolute `performance.now()` deadline; an earlier caller deadline stops retries
and rejects late replies. Reads still throw when their bound expires, and other
service errors throw immediately. `isEventStoreUnavailable(error)` identifies
the same transient NATS failures without exposing SDK types to callers.
A failed authority read proves neither permission nor denial;
it must never extend a caller's existing permission lease. A failed subscription
batch cancels its sibling reads so they cannot keep retrying after the failure.

An optional `expectedSubject` can select the event's whole category, such as
`member-*`, instead of its entity. `expectedSequence` then checks the latest
sequence across that category in the same native conditional publish. Only the
event's own subject or category is accepted. Bootstrap uses zero across all
member streams, which also contain identity bindings, to require a fresh silo.

By default, command identity is checked in entity history before every attempt
and again after a conflict. It is scoped to commandId, principal kind/id and
subject. Reusing a key returns the earlier sequence even if the caller supplies
new event data. These default history searches grow with the entity's history.

`historyChecked: true` skips the search before publishing, including on retries.
The caller must have checked every event on the event's own subject up to
`expectedSequence` and found no earlier copy of that command. Any other supplied
value is rejected as `invalid_event`. These callers opt in:

- `BudgetActor` replays the budget stream. Ordinary commands use new random ids;
  `configure` checks caller-supplied command ids separately.
- `recordReport` checks the chat summary's report position for that computer and
  report sequence, through the copied stream position.
- `turnCommand` checks the computer summary's start command keys (principal kind,
  principal id and command id). A close is written only when no close exists for
  the turn. A repeated start returns without an append, including after the
  120-second NATS duplicate window.

After a conditional refusal (10071 or 10164), this mode searches the event's own
subject only from `expectedSequence + 1`. It returns the first matching copy's
position, or `conflict` if none exists. A lost reply or racing attempt cannot
store another copy: retries keep the original expected position. The normal
path makes one publish and no history reads. A refusal reads only later events.
Both modes keep the same Msg-Id and conditional headers. Duplicate
acknowledgements still check the saved event with `sameCommand`.
Decision audits also opt in. Each uses a new command id and a new decision stream
at position zero, so there is no earlier matching request to find.
No separate ledger or duplicate window determines command success.

`readStream(subject, fromSequence)` is a finite snapshot through the head
observed on entry; `fromSequence` is an inclusive global position.
`readEventAt(store, subject, sequence, deadline)` returns the first row only when
its global position equals `sequence`; it returns `undefined` for a gap or missing
row. It reads at most one row and keeps the caller's absolute deadline.
Read subjects may select a category, such as `member-*`; appends still require an entity.
`subscribe(fromSequence, signal)` reads exact global sequences from the caller's
SQL checkpoint, with no durable consumer cursor. Historical reads fetch at most
64 messages concurrently and yield them in global order; abort stops retries and
is checked before each yield. Authority scans no longer wait for each event's network round trip
before requesting the next.
It polls the live tail every 100 ms;
break or abort to stop it. Read-ahead cannot change the next subscription's position.
`head()` supports bounded projection drains. Provision EVENTS and the dispatcher
with `npm run provision`; see [ADR 0005](../../docs/adr/0005-nats-access.md).
`ensureStream` verifies file storage, replicas and unlimited retention and
refuses incompatible configuration. Deletion/purge are disabled; payload
forgetting needs a separate qualified design. Callers supply credential file paths
and own connection shutdown; one connection serves one silo.

`createEventStore` uses the SDK's normal five-second management request timeout
for its initial account check and for `ensureStream`'s lookup and creation.
Creation waits for NATS to reply and does not retry. A timeout can mean the stream
was created without its reply reaching the caller; rerunning provisioning checks
the stored configuration. Event reads and publishes still use 250 ms requests,
with their existing overall deadlines. Both managers use the same connection.
Direct `new EventStore(client, manager, provisioningManager = manager)` callers
own those managers' timeouts.

## Dated MCP catalogue evidence

Dated MCP snapshots are checked with `validateMcpCatalogue` before append. The saved
accepted tool count must match the complete tool list. Each definition supplies its own
name, annotations and SHA-256 revision. The catalogue digest is calculated from these
checked names and revisions. A nested changed catalogue must also match its event's
server id and new digest. Old undated records still parse; policy reads keep them blocked.
The event parser requires the exact `mcp-<serverId>` subject for all MCP records.

## Stream summaries

`readStreamSummary(store, silo, subject, kind, deadline, take)` keeps facts in
memory for one store instance, kind name, silo and subject. `SummaryKind` supplies
`name`, `keep`, `empty()` and `add(summary, row)`. Names must identify one summary
shape; `keep` is a positive entry limit. The least recently used entry is dropped
when that limit is exceeded. An optional `budget: { limit, size(summary) }` also
bounds the combined size of all entries of a kind. Its size function must be
quick and count every growing part of the summary. The growing chat and computer
kinds estimate bytes from measured costs. After every catch-up, including a failed
partial read, the helper drops least recently used whole entries until their
combined size fits. If the entry just read exceeds the entire budget, only that
entry is dropped. Other streams stay warm.
The current call and already queued calls still finish on their entry and return
complete facts; eviction never removes an individual refusal fact. A dropped
entry rebuilds from sequence 1. Active catch-ups and returned copies are outside
this retained-cache budget.

`NODE_DEBUG=opencrane-summary` uses Node's debug log to report each read starting
from sequence 1, with its kind, stream and silo. These lines help count rebuilds
without retaining another history or changing normal application logs.

Each call queues its own catch-up, starting after that call began. It reads from
the last added global position plus one to the head observed by `readStream`.
Calls on one entry run in order, so they never add an event twice. A wrong-silo row
throws `WrongSiloError` before `add`. `add` must check before changing facts and
leave them unchanged if it throws. The saved position advances only after `add`
succeeds. An interrupted read keeps the events it already added.

`take` runs in the same queue slot after the catch-up reaches its head. It copies
needed facts into a plain result; callers must never retain the mutable summary.
A partial or failed catch-up never runs `take`. Every access check gets its own
fresh catch-up, including when a previous call is still reading.

The caller's deadline uses absolute `performance.now()`. On expiry, the caller
receives the same NATS `TimeoutError` as a stream read. Catch-up continues with a
deadline of at least ten seconds from its start, or the caller's later deadline.
`Infinity` stays unlimited. Background failures have error handlers and release
the queue so another call can continue from the saved position.

### Backup and restore

Summaries assume saved events only grow. A backup restore can move the event log
backwards. The server and models processes must restart after every event-store
restore, before serving traffic. This clears all summaries and rebuilds them from
sequence 1. The Phase 5 restore drill must include these restarts, alongside
rebuilding projection checkpoints. Skipping the restarts can keep a suspended or
lost computer allowed by stale facts. No summary is stored in a backup or in SQL.

## Stream configuration

Every field in NATS JavaScript 3.4.0's `StreamConfig` has a decision below;
the type checker requires a decision when the SDK adds a field. Creation
sets required values and disabled features explicitly. Verification accepts
omitted server defaults where stated and never repairs an existing stream.

| Fields | Compatible values and reason |
| --- | --- |
| `name`, `subjects` | `EVENTS`, exactly `["ev.>"]`; one silo event log. |
| `storage`, `retention` | `file`, `limits`; durable history independent of consumers. |
| `num_replicas` | Requested 1, 3 or 5; default 3. |
| `max_consumers` | `-1`; no stream limit on projection consumers. |
| `max_msg_size` | `-1`; event schemas do not share a maximum encoded size, so no finite stream limit is safe. Server/account payload limits still apply and must be provisioned separately. |
| `max_msgs`, `max_bytes`, `max_msgs_per_subject`, `max_age` | `-1`, `-1`, `-1`, `0`; never expire history. |
| `discard`, `discard_new_per_subject` | `old`, false (or omitted); discard never applies with unlimited retention. |
| `deny_delete`, `deny_purge`, `sealed`, `no_ack` | true, true, false, false; retain history, allow writes and require acknowledgements. False may be omitted. |
| `duplicate_window` | Exactly 120 seconds in nanoseconds; stable message-id collision detection. Command retries also use stored history beyond this window. |
| `republish`, `subject_transform`, `mirror`, `sources` | Absent; no extra delivery, subject changes or imported events. |
| `allow_rollup_hdrs`, `allow_msg_ttl`, `subject_delete_marker_ttl` | false, false, `0` (or omitted); no replacement, expiry or generated deletion markers. |
| `allow_msg_counter`, `allow_msg_schedules`, `allow_atomic`, `allow_batched` | false (or omitted); ordinary single-event appends only. |
| `persist_mode` | `default` (or omitted); do not opt into asynchronous persistence. |
| `consumer_limits` | Absent, empty, or both `inactive_threshold` and `max_ack_pending` zero; no stream-level restrictions on consumers. |
| `first_seq` | Omitted, `0` (server default) or `1`; start the log at sequence 1. |
| `mirror_direct` | false (or omitted); this stream is not a mirror. |
| `allow_direct` | Either value or omitted; the adapter uses the management read API. |
| `compression` | Omitted, `none` or `s2`; lossless storage choice. |
| `description`, `metadata`, `placement` | Any valid values or omitted; labels and replica placement do not change event semantics. |

## Tests and dependencies

Root `npm test` fetches the pinned test server automatically after `npm ci`.
OpenSSL must be on PATH to generate a fresh test CA and one-day certificates.
`natsFixture()` shares one pending certificate generation in its loaded test module.
It keeps the generated files in memory and copies them into each fixture's private
directory with mode `0600`. Changing or removing those copies cannot change later
fixtures. Each fixture still has its own NATS server, port and JetStream storage.
`natsFixture({ freshCertificates: true })` generates a separate CA and credentials
for trust refusal tests. Direct `certificates(directory, days)` calls still generate
fresh credentials, including the development stack's 30-day certificates.
Test stream creation uses the production provisioning timeout without a fixture retry
or sleep. A failed creation closes the fixture before throwing.
`test/provision.test.ts` holds real stream lookup and creation replies past 250 ms
with a paused TCP proxy and a controlled timer. Each case then creates a usable log.
It also checks that a server which never replies times out at five seconds.
For focused tests, run `sh scripts/fetch-nats.sh`, then
`npx vitest run libs/event-store/test`. Tests launch random-port NATS servers
and prove conditional races, scoped retries, ordered reads, restart/outage
bounds and native snapshot/restore idempotency. `@opencrane/event-store/testing`
is test infrastructure only. Its `countReads(store)` helper wraps the instance's
`readStream`, including append's internal searches. Calls record subject,
fromSequence and yielded rows; `clear()` starts a new measurement.
`expectNoWholeReads(calls, largestAllowed = 20)` refuses reads from sequence 1
or earlier that yield more than the allowed rows. This helper does not count
whole-log reads through `subscribe`. Security tests prove command/reader/excluded roles,
unknown and missing credentials, plaintext and wrong-CA refusals. The pinned NATS server is 2.15.0; both downloaded
platform archives have fixed SHA-256 checksums.

`test/stream-summary.test.ts` covers replay, queued freshness, store/kind/silo
separation, eviction, caller timeouts, retained progress and background errors.

Dependencies: `@opencrane/events`; NATS JavaScript packages 3.4.0 and
nats-server 2.15.0 are Apache-2.0. Licences were checked at introduction.
See the [event catalogue](../../docs/architecture/events.md) and
[plan](../../plan.md#event-driven-core). TLS/account isolation passes against real R1 servers. Live R3 elections with this
configuration and a fresh silo installation remain unqualified.

`test/cluster-routes.test.ts` uses the production cluster configuration with three
disposable pinned servers. It checks route authentication, a leader with two current
replicas, conditional append, stale-position refusal and PostgreSQL member replay
through the projection identity. It also checks publish refusals and rejects R3
verification of an existing R1 stream without changing it. It requires
`PG_TEST_URL` for a throwaway PostgreSQL database; missing setup is not skipped.
See [cluster settings](../../infra/nats/README.robot.md) for trust rules and limits.

`chat-state-<memberId>` maps to `ev.chat-state.<memberId>`, including category reads.
Preference parsing binds the human principal to that member id. Access checks remain the caller's job.

`expectedGlobalSequence` is allowed only for `ownership.seeded`,
`provider.managed_calls_drain_set`, `provider.managed_calls_enabled` and
`mcp.configuration_observed` and `conversation.child_result_published`. A drain command captures the global position
before loading provider configuration and spending mode. Its one append checks
both that position and the provider-category position. This refuses switch-on on
the budget stream between the command's last check and its append. Any other new
event also causes a conflict; the administrator can reload and try again.

Preference parsing binds the human principal to that member id. Access checks remain the caller’s job.

## Conversation closing writes

The server writes new `conversation.closed` commands to `participation-<conversationId>`.
The append adapter also accepts `conversation-<conversationId>` for older callers.
Both forms must match the data id and retain the same conditional append and retry rules.
Older closing events still parse and replay. Participant writes still require participation.
`test/conversation-command.test.ts` checks current and older appends and reads.

Conversation activity reads can pass `includeConversationCloses: true` in a summary kind,
or `true` as the fourth `readStream` argument. This uses one indexed NATS query,
`ev.*.<conversationId>`, and returns only the exact conversation's events and its
participation-stream closes. It never returns another entity's events or participant changes.
Ordinary stream reads and append positions keep their existing meaning.
The matching third `head` argument returns the query's latest candidate position.
An unrelated entity with the same id can advance that position, but cannot supply
activity or access facts. The activity reader filters these rows before making a decision.
Model decisions use this path for both their initial history and later changes.
They do not start another participation-stream read.

## Conversation creation and stream counts

`conversation.created` requires an empty exact conversation stream. An exact
conditional append must expect position zero. A category conditional append also
checks that the exact stream is empty before its category append; the category
condition refuses any intervening creation. Normal retries still return their
original result. A history-checked category retry reads only the first event to
recover a lost creation reply. Existing events remain readable and replayable.

`subjectCount(deadline)` reads `StreamInfo.state.num_subjects`. It does not request
a subject list or read events. Missing counts on a populated stream are refused.
The EVENTS retention checks disallow deletion, expiry and subject transformation,
so the count never drops and one saved logical subject corresponds to one NATS
subject. Member inventory compares this count with its rebuilt index to detect
new history before the worker processes it. `test/conversation-command.test.ts`
checks empty-stream creation, category checks and retries.

Switch-on captures that same global position before its incremental history reads.
It appends to `budget-<silo>` with `historyChecked`, checking both the budget
position and global position. A concurrent reservation, turn start, binding change,
drain cancellation or second switch-on therefore causes a conflict.

Tool publication receipts capture the global position before reading the server and
checking the current gateway preparation. Their append checks both the server and
global positions. A newer preparation on the gateway stream therefore refuses the
receipt atomically. Other concurrent writes can also refuse it; observation retries
from current records. This check does not change read access or call admission.

Child publication samples the global position before reading later result events.
Its parent append checks that position together with the parent stream position.
The server retries definite conflicts after reading new rows and checking result
validity and access again. The adapter performs no result or access decision itself.
The NATS publish regression inserts a loss immediately before sending the write and
requires a conflict with no parent entry. Read access checks stay unchanged.

## Shared test ports

The nine former `freePort` copies now use `@opencrane/event-store/testing`.
Each Vitest worker uses 200 ports, starting at `20000 + VITEST_POOL_ID * 200`.
Workers 0 to 24 are supported. The helper skips `EADDRINUSE` and stops after
200 attempts. This keeps ports below 25000, away from the secondary dev stacks
at 25100 and 25200 and the Linux outgoing range starting at 32768.
Separate test runs can share worker ids, so listeners are checked before use.
