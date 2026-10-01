# ADR 0005: NATS access for the Phase 1 event core

Date: 2026-10-01. Status: implemented; fresh-silo qualification remains NOT RUN.
Extends [ADR 0001](0001-event-store-nats-jetstream.md)'s unauthenticated spike.

## Decision and reason

Use native NATS accounts and subject permissions, with mutual TLS certificate
mapping (`verify_and_map`). The [server configuration](../../infra/nats/nats.conf)
is the permission contract used by the real-server tests. TLS starts before NATS
sends INFO; plaintext and opportunistic TLS are disabled. Clients explicitly
verify the server certificate and require the CA, certificate and key file paths.

This uses the existing Apache-2.0 NATS server/client and OpenSSL in tests, with no
new library or authentication service. Certificate mapping avoids a second set of
passwords or NKey seeds alongside TLS. JWT operators/resolvers would add issuance
and distribution machinery that this single-silo account layout does not need.
See [NATS certificate mapping](https://docs.nats.io/learn/security/encryption).

## Identities and permissions

| Certificate subject | Account | Rights |
| --- | --- | --- |
| `CN=command` | `EVENT_CORE` | Publish `ev.>`; manage and read the `EVENTS` stream and its consumers. Used by the server's command handlers and initial stream provisioning. |
| `CN=projection` | `EVENT_CORE` | Read stream info/messages; create, inspect, delete and pull EVENTS consumers; acknowledge deliveries. No stream mutation or event publishing. |
| `CN=dispatcher` | `EVENT_CORE` | Same read permissions, using the dispatcher's durable consumer. |
| `CN=computer`, `CN=gateway` | `EXCLUDED` | Explicitly deny all publishes/subscriptions; no JetStream and no account imports/exports. |
| Any other certificate or no certificate | None | Connection refused. Browsers receive no NATS credential. |

Readers subscribe only to reply inboxes. A consumer pull or acknowledgement is a
NATS publish, so its specific API subjects must be allowed; it cannot append to
`ev.>`. Empty allow lists do not deny access in NATS: excluded identities use
explicit `deny: [">"]`. The security tests assert actual permission violations,
not timeouts, and verify the stored history/configuration remain unchanged.

Reader roles share a silo and can manage each other's consumers. This protects
event integrity and excludes other accounts; it does not isolate consumers from
a compromised reader within the same silo. Command credentials include stream
administration for provisioning and recovery; restrict their distribution to the
command service and authorised operators. A separate operator role can narrow
this further when the installation workflow exists.

## Installation contract

Mount the configuration and secret-store-issued short-lived certificates as files.
Set `NATS_LISTEN`, `NATS_STORE_DIR`, `NATS_CA_FILE`, `NATS_CERT_FILE`, `NATS_KEY_FILE`
on nats-server, then run `nats-server -c infra/nats/nats.conf`. Use a dedicated CA
per silo; the server certificate needs SANs for its service DNS names. Issue client
certificates with the exact subjects above and clientAuth usage, without alternate
identity SANs. Keep the CA signing key in the secret store, never in application
pods. Each client receives only its own certificate/key and the CA certificate.

Clients set `NATS_URL`, `NATS_CA_FILE`, `NATS_CERT_FILE`, `NATS_KEY_FILE` and use
`connectNats()` or `connectEventStore()` from the event-store package. Values are
file paths, not PEM or credentials in URLs. An unset, blank or unreadable required
file fails the connection; there is no anonymous or insecure fallback. The server
may still run its existing auth-only mode with NATS disabled; membership then
returns unavailable. Provision EVENTS separately (`ensureStream`, R3 by default).

A later Helm chart can mount this same config and role-specific Secret volumes.
Certificate issuance, renewal/reload, revocation, network policy and TLS for R3
cluster routes need installation qualification; this change qualifies the client
listener on disposable R1 servers. Do not claim a production certificate lifecycle
or a fresh installed silo from these tests.

## Evidence

The [receipt](../process/nats-auth-evidence.md) records commands and gate counts.
The shared fixture generates a fresh CA and one-day client/server certificates in
an ignored disposable directory, removes them on cleanup and never commits keys.
Real tests cover native permissions, TLS refusals, HTTP command append, reader
replay, dispatcher crash/restart, PostgreSQL 17 and OpenFGA delivery under TLS.
