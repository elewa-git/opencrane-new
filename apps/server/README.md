# Server

The Node service exposes sign-in routes, invitation acceptance, the organisation MCP register, a health check and an authenticated WebSocket
skeleton. It does not serve static files: `GET /` returns 404. The [web app](../web/README.md)
is built and served separately; during development Angular's server runs on port 4200 and
proxies `/auth` and `/ws` here on port 8080. The membership command writes only to
the event store; projection writes belong to listeners in `libs/projections`.

## Entrypoint and operation

[main.ts](src/main.ts) starts Fastify and attaches `/ws`. From the repository root:

```sh
npm start -w apps/server
curl --fail http://localhost:8080/healthz
```

Provision OIDC settings first; startup rejects missing or invalid configuration.
Required: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI` and
`OIDC_COOKIE_SECRET` (at least 32 bytes, injected from the secret store).
Production also requires `OIDC_EXPECTED_ORG_ID`. The callback is `/auth/callback`.
See [auth configuration and defaults](../../libs/auth/src/config.ts), including
client-secret indirection, scopes, cookie settings and provider claim names.
`HOST` defaults to `0.0.0.0`, `PORT` to `8080`, `LOG_LEVEL` to `info`.
`OTEL_EXPORTER_OTLP_ENDPOINT` enables optional trace export when set.
Disabling secure cookies or allowing insecure OIDC HTTP is only for local testing.

Set `NATS_URL`, `SILO_ID` and `OIDC_EXPECTED_ORG_ID` to enable membership acceptance.
`SILO_ID` is the event silo; the OIDC setting pins the session organisation. Startup
refuses a NATS configuration missing either pin. Provision the silo's `EVENTS`
stream separately with the [event-store adapter](../../libs/event-store/README.md).
Without NATS configuration, authenticated membership requests return unavailable.
The process owns and closes its NATS connection. Set `NATS_NKEY_SEED_FILE`, `NATS_CA_FILE`, `NATS_CERT_FILE`
and `NATS_KEY_FILE` to mounted files for the command role, and set
`NATS_INBOX_PREFIX=_INBOX.command`; missing credentials fail startup. TLS and permissions use [ADR 0005](../../docs/adr/0005-nats-access.md).
Never put credentials in a URL or event. Fresh-silo qualification remains pending.

## Contract and verification

`GET /auth/login` redirects to the provider; `GET /auth/me` reports the session.
`POST /auth/logout` clears the local cookie and returns a validated provider logout URL or `null`.
Invalid callbacks return 400; `/ws` upgrades require a valid cookie and matching Origin.
The socket supports resumable members subscriptions, plus the existing hello and event-validation demos; it never appends events.
See [protocol schemas](../../libs/protocol/README.md) for real request examples.

`POST /members/join` requires the encrypted session cookie, JSON and an `Origin`
matching the OIDC redirect origin. Example JSON:

```json
{"memberId":"alice","invitationId":"invite-alice","commandId":"join-alice","displayName":"Alice"}
```

The [typed result](src/members/join.ts) is `joined` or `already_joined` (200, with
`memberId` and global `sequence`), `refused` (with a stable `reason`), or
`unavailable` (503). Missing/invalid/expired sessions return 401, an invalid Origin
or other session organisation returns 403, invalid command fields return 400,
and domain refusals return 409. Fastify rejects malformed JSON and oversized bodies
before command execution. Unknown fields, including client-supplied roles/silos,
are refused. Reuse the same command id and arguments after an ambiguous 503.
Acceptance reads member history and makes at most one conditional append to that
member's stream. It never writes PostgreSQL, OpenFGA or a command ledger. The
returned sequence lets a caller wait for a listener's projection checkpoint.
See the [invitation contract](../../docs/architecture/events.md#organisation-members-and-teams)
for identity/expiry requirements, retries and the missing bootstrap policy.

```sh
npm test -- apps/server
npm run typecheck -w apps/server
```

Set `PG_TEST_URL` to a disposable PostgreSQL 17 database for the acceptance-to-members
test; it is explicitly skipped otherwise. It uses an isolated schema and real NATS,
then restarts the database connection and rebuilds the projection. Other command
tests prove races, durable retries after NATS restart, refusals with no append and
real read/append outages. Tests also cover Node startup, OIDC, upgrades and redaction.
The [acceptance evidence](../../docs/process/member-joined-evidence.md) records gate counts and untested conditions.
A deployed fresh-install sign-in journey remains unqualified by these local tests.
The process needs a listening port and outbound access to its OIDC provider and optional
collector, NATS, PostgreSQL and OpenFGA. Restart discards connections; clients reconnect.
Cookies survive only while their signing/encryption configuration and expiry remain valid.
Business recovery and replay use the event-store and projection libraries.

Dependencies: Fastify, ws, and the [auth](../../libs/auth/README.md),
[events](../../libs/events/README.md), [observability](../../libs/observability/README.md)
and protocol packages, plus event-store and Zod (MIT, existing pin). PostgreSQL
(`pg`, MIT), projections and authz now serve realtime reads; no new external component
was introduced. See the [architecture and plan](../../plan.md).

## Members realtime and shutdown

Set `DATABASE_URL`, `OPENFGA_API_URL`, `OPENFGA_STORE_ID` and `OPENFGA_MODEL_ID`,
plus `SILO_ID` and `OIDC_EXPECTED_ORG_ID`, to enable the members topic. The server
needs read access to the members projection and a LISTEN connection. Provision
and run the existing projection runner and OpenFGA handler separately; the HTTP
server does not become another projection writer. Existing projections must be
stopped and rebuilt once to populate the new change history and identity bindings.
Without configuration or permission, subscriptions fail closed.

Send `{"type":"subscribe","topic":"members","since":0}` on the tab's existing
`/ws` connection. Only one subscription per connection is supported. The server
resolves the session's issuer/subject to a joined member through the projection,
then checks the silo's `member` permission through OpenFGA. Cookie roles are ignored.
Ambiguous or absent identity bindings are refused. Old unbound joins need a bound
invitation before they can subscribe. Permissions are checked on reads and at
one-second intervals (plus dependency latency); failures stop delivery. Session
expiry is checked there too. This is bounded revocation, not instantaneous logout.

Version 1 replies are `member`, `ready`, `resync` or `refused`; every reply has
`topic`, `version` and a safe integer `position`. A `member` contains the full row
at that position. Positions are global event-log sequences filtered to this silo's
members changes, so numeric gaps are normal. Apply rows in order, remember the
last applied position and reconnect with it. `ready` marks initial catch-up.
Positions ahead of the projection are refused. The original demo messages remain
separate from this versioned subscription protocol.

PostgreSQL delivers `members_changed` NOTIFY only after the projection transaction
commits. Its payload is a wake-up, never data or permission: the server rereads
ordered changes in pages of 100. A failed LISTEN connection fails subscriptions
closed; restart the server to restore it. Reconnect always rereads durable history.
Changes have no pruning in this skeleton. Stop readers before an offline rebuild;
clients retaining positions can resume after the same log has been replayed.
Multi-replica fan-out over NATS core is **not implemented**.

## Organisation integrations

`GET /org/integrations` requires the encrypted session cookie, the configured silo and
organisation, a joined issuer/subject binding in the members projection, and current
OpenFGA `admin` permission (which includes owners). Cookie roles are ignored. Missing or
unavailable authority fails closed. The response follows `integrationsResponseSchema`:
event-derived server/source/tool/status rows plus `loadedAt`. The current MCP events do
not carry catalogue display metadata, semantic versions or account models, so the API
returns derived server labels and explicit “Version not provided” / “Not configured”
copy rather than invented facts.

`DATABASE_URL` and the existing OpenFGA settings enable this route as well as members
realtime. The `mcp catalogue` projection must run separately; the server remains a
read-only projection client. The real-service test creates disposable PostgreSQL 17
databases and uses real NATS and OpenFGA:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run apps/server/test/integrations.test.ts
```

Sockets allow 20 application messages per one-second window and 16 KiB inbound
frames. Ping/pong runs every 15 seconds; a missing pong terminates the peer at the
next tick. Above 64 KiB queued output, the server drops further live deltas,
sends `resync` and closes with 1013. The queue can also contain one row being sent.
The projection retains every state: resume from the last position actually applied
by the client, not the last position the server attempted to send.

`SHUTDOWN_GRACE_MS` defaults to **10000**, a positive integer up to 2147483647.
The first SIGTERM/SIGINT closes the listener, sends WebSocket close code 1001 and
lets HTTP requests use the full grace period. No part is reserved by cutting off
requests early. After HTTP and sockets close, NATS, the feed and telemetry close
once. A clean shutdown exits 0; cleanup failure or expiry exits 1. At expiry,
remaining sockets are destroyed and cleanup is invoked if it has not started;
the next event-loop turn exits 1 even if a closer is still hung. Thus a timeout
reports incomplete cleanup, never success. A second signal exits 1 immediately.
