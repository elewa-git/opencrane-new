# Event store

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
maps the first hyphen to `ev.member.alice`; ids may contain further hyphens,
but no dots, whitespace or NATS wildcards. Event types must use their
registered stream prefix. `commandId` and `principal` are required for
appends, including an explicit system principal for system commands.

`append` returns `appended` with the global sequence, `conflict` for a stale
expected subject sequence, `rejected` for invalid input or an unrelated
duplicate id, or `unavailable` after bounded backoff. Timeouts and server
unavailability retry for ten seconds, with at most one final 250 ms read.
It preserves the original expectation: callers reload and revalidate on
conflict. Unexpected configuration/permission/corruption errors throw with
the original cause. The `unavailable.cause` is internal diagnostic data;
HTTP callers must expose only the status. An unavailable result can be
ambiguous: retry with the same command key.

Command identity is checked in entity history before every attempt and
again after a conflict. It is scoped to principal kind/id and subject.
No separate ledger or duplicate window determines success. Reusing a key
returns the earlier sequence even if the caller supplies new event data.
History scans are linear; very large entity histories need a later indexed
read optimisation that preserves this guarantee.

`readStream(subject, fromSequence)` is a finite snapshot through the head
observed on entry; `fromSequence` is an inclusive global position.
`subscribe(fromSequence, signal)` reads exact global sequences from the caller's
SQL checkpoint, with no durable consumer cursor. It polls the live tail every 100 ms;
break or abort to stop it. Read-ahead cannot change the next subscription's position.
`head()` supports bounded projection drains. Provision EVENTS and the dispatcher
with `npm run provision`; see [ADR 0005](../../docs/adr/0005-nats-access.md).
`ensureStream` verifies file storage, replicas and unlimited retention and
refuses incompatible configuration. Deletion/purge are disabled; payload
forgetting needs a separate qualified design. Callers supply credential file paths
and own connection shutdown; one connection serves one silo.

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
| `max_msg_size` | `-1`; event schemas have no maximum encoded size, so no finite stream limit is safe. Server/account payload limits still apply and must be provisioned separately. |
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
For focused tests, run `sh scripts/fetch-nats.sh`, then
`npx vitest run libs/event-store/test`. Tests launch random-port NATS servers
and prove conditional races, scoped retries, ordered reads, restart/outage
bounds and native snapshot/restore idempotency. `@opencrane/event-store/testing`
is test infrastructure only. Security tests prove command/reader/excluded roles,
unknown and missing credentials, plaintext and wrong-CA refusals. The pinned NATS server is 2.15.0; both downloaded
platform archives have fixed SHA-256 checksums.

Dependencies: `@opencrane/events`; NATS JavaScript packages 3.4.0 and
nats-server 2.15.0 are Apache-2.0. Licences were checked at introduction.
See the [event catalogue](../../docs/architecture/events.md) and
[plan](../../plan.md#event-driven-core). TLS/account isolation passes against real R1 servers. Live R3 elections with this
configuration and a fresh silo installation remain unqualified.
