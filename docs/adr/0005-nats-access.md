# ADR 0005: NATS access for the Phase 1 event core

Date: 2026-10-01. Status: implemented; fresh-silo qualification remains NOT RUN.
Extends [ADR 0001](0001-event-store-nats-jetstream.md)'s unauthenticated spike.

## Decision and reason

Use mutual TLS for transport and native NKey challenge authentication for roles.
The [server configuration](../../infra/nats/nats.conf) is the permission contract
used by real-server tests. TLS starts before INFO; plaintext and opportunistic TLS
are disabled. Clients verify the server certificate and present a client certificate.

Certificate mapping (`verify_and_map`) is deliberately disabled. NATS checks DNS,
email and URI SANs before the subject; a trusted certificate with `CN=unknown` and
`URI:CN=command` could therefore obtain command rights in the original configuration.
Requiring particular CNs or asking certificate holders to omit SANs did not enforce
that boundary. See [NATS certificate mapping](https://docs.nats.io/learn/security/encryption).

Only possession of a configured role's private NKey seed now selects that role.
Certificate subjects, SANs, usernames, inbox prefixes and claimed public keys cannot
replace a valid signature of the server's nonce. TLS certificate issuance can share
an issuer with other services without granting those services a NATS role. This uses
the existing Apache-2.0 NATS server/client and OpenSSL in tests; no new dependency or
authentication service. See [NATS NKeys](https://docs.nats.io/learn/security/authentication-basics).

## Identities and permissions

| NKey role | Account | Rights |
| --- | --- | --- |
| command | EVENT_CORE | Publish `ev.>`; manage/read EVENTS and its consumers. Used by command handlers and authorised provisioning jobs. |
| projection | PROJECTION | Read EVENTS info/messages by sequence. Legacy inspect/pull access is limited to `projection-members`, `projection-authz`, `projection-replay`; the runtime no longer uses these consumers. No acknowledgements. |
| dispatcher | DISPATCHER | Read EVENTS info/messages; inspect, pull and acknowledge only `handler-dispatcher`. |
| computer, gateway | EXCLUDED | Deny all publishes/subscriptions; no JetStream or imports/exports. These test identities demonstrate refusal; production need not issue them NATS seeds. |
| Unknown NKey or absent authentication | None | Connection refused, even with a trusted certificate. Browsers receive no NATS credential. |

Readers have separate accounts and narrowly scoped service imports from EVENT_CORE.
Only the command account enables JetStream. Pull responses use streaming service
exports. Each reader can subscribe only to its role's inbox prefix. A forged reply
address stays inside the reader account: it cannot deliver into another role's inbox
or append API responses/events to the source stream. Dispatcher acknowledgements have
one explicit consumer subject import; projection has none.

Readers cannot create, update, delete, reset or pause any consumer, including their
own. This is stronger than prefix-only create permissions: NATS subject permissions
cannot validate a consumer's JSON configuration, including its push delivery address.
NATS wildcards match whole tokens, so `projection-*` would not express a name prefix.
We enumerate the three current projection names and one dispatcher name instead.
New projections need no consumer or permission change: they read EVENTS by sequence.
The dispatcher consumer filters `ev.>` and is pull-only; readers cannot change this.

The former acceptance of cross-role consumer administration is withdrawn. A
compromised reader can still disrupt its own role's delivery progress and read the
whole silo event history; it cannot control the other role's consumers. Command
credentials retain stream/consumer administration for provisioning and recovery.
Distribute them only to the command service and authorised installation/replay jobs.

## Installation and replay contract

A Helm installation mounts this configuration and secret-store-issued TLS files.
Set `NATS_LISTEN`, `NATS_STORE_DIR`, `NATS_CA_FILE`, `NATS_CERT_FILE`, `NATS_KEY_FILE`
on nats-server, plus `NATS_COMMAND_NKEY`, `NATS_PROJECTION_NKEY`,
`NATS_DISPATCHER_NKEY`, `NATS_COMPUTER_NKEY`, `NATS_GATEWAY_NKEY`: **public** keys only.
Run `nats-server -c infra/nats/nats.conf`. The server certificate needs service DNS
SANs. Keep the CA signing key in the secret store, outside application pods.

Clients set the URL and TLS file paths above, `NATS_NKEY_SEED_FILE` (a mounted secret
file) and `NATS_INBOX_PREFIX` (`_INBOX.command`, `_INBOX.projection` or
`_INBOX.dispatcher`). Use `connectNats()` or `connectEventStore()`. Each workload gets
only its own seed/certificate/key; seeds never enter events, configuration values or
URLs. Missing, blank or unreadable required files fail closed. The server still
supports its existing auth-only mode with NATS disabled.

Before starting readers, run `npm run provision` with command credentials. This
production entrypoint creates/verifies EVENTS (R3 by default; `NATS_REPLICAS=1` for
local tests) and provisions `handler-dispatcher`. An incompatible stream fails
without repair. The Helm job will run this command; no Helm chart is supplied here.
Reader pods need no command seed. No projection consumer is provisioned.

Every `store.subscribe(checkpoint + 1, signal)` now reads exact global sequences
through the existing `STREAM.MSG.GET.EVENTS` permission. There is no server-side
projection cursor: delivery, local read-ahead and crashes cannot advance SQL state.
The projection runner still commits effects and its checkpoint in one transaction.
A missing sequence at or below the observed head fails as a gap. The live tail polls
every 100 ms; historical reads run without delay. Abort or close ends a subscription.
Independent projections and rebuilds each start from their own SQL checkpoint;
keep one active runner per projection, and stop it before resetting its SQL tables.

This supersedes the durable AckNone projection and manual delete/re-provision restart
procedure. AckNone records delivery before SQL commit; both crashes and prefetch past
a bounded drain's head could skip events. Allowing reader consumer creation would
also allow push delivery through the JSON body, which subject permissions cannot
constrain. Exact-sequence reads use existing rights and avoid that administration
boundary entirely. The cost is one request per historical event and polling at the
tail; optimise only with equivalent restart and isolation evidence.

The dispatcher retains its explicit-ack durable consumer and acknowledges only after
all jobs and its SQL checkpoint commit. A crash before commit redelivers; a crash
after commit but before acknowledgement redelivers and deduplicates using SQL. After
acknowledgement, the next event remains pending until its own SQL commit. Restart
retains the consumer; a controlled rebuild must reset SQL and consumer together.

NKeys have no intrinsic expiry. Secret-store leases must rotate seeds and update/reload
the server's public-key configuration, retiring old connections. Issuance, rotation,
revocation, certificate renewal, network policy and TLS on R3 routes require live
installation qualification. These disposable R1 tests do not establish a production
credential lifecycle or a fresh Helm installation.

## Evidence

The [receipt](../process/nats-auth-evidence.md) records commands and gate counts.
Fixtures generate a fresh CA, one-day certificates and random NKeys in ignored
folders, remove them on cleanup and never commit keys. Real-server tests cover
SAN/CN and NKey impersonation, consumer creation/update/deletion and filter/delivery
attacks, cross-role acknowledgements, forged replies, and the positive HTTP command,
projection replay and dispatcher crash/restart paths with PostgreSQL and OpenFGA.

The owner-approved final fix adds real PostgreSQL/NATS tests for projection SIGKILL
before SQL commit, bounded drain with an explicitly discarded prefetched event, and
dispatcher SIGKILL after acknowledgement (in addition to both sides of SQL commit).
Handler fixtures invoke the production provisioning command on an empty server;
a fresh-server journey proves append, projection and durable dispatch. Projection
fixtures use the production adapter directly, with no subscription-time provisioning.
Fresh Helm/R3/credential-lifecycle qualification remains NOT RUN.
