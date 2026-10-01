# Server

The Node service exposes sign-in routes, invitation acceptance, a health check and an authenticated WebSocket
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
`SHUTDOWN_GRACE_MS` sets the graceful-shutdown deadline in milliseconds and
defaults to `10000`; it must be a positive integer.
Disabling secure cookies or allowing insecure OIDC HTTP is only for local testing.

Set `NATS_URL`, `SILO_ID` and `OIDC_EXPECTED_ORG_ID` to enable membership acceptance.
`SILO_ID` is the event silo; the OIDC setting pins the session organisation. Startup
refuses a NATS configuration missing either pin. Provision the silo's `EVENTS`
stream separately with the [event-store adapter](../../libs/event-store/README.md).
Without NATS configuration, authenticated membership requests return unavailable.
The process owns and closes its NATS connection. TLS/account isolation still needs
live qualification; never put long-lived credentials in a URL or event.

## Contract and verification

`GET /auth/login` redirects to the provider; `GET /auth/me` reports the session.
`POST /auth/logout` clears the local cookie and returns a validated provider logout URL or `null`.
Invalid callbacks return 400; `/ws` upgrades require a valid cookie and matching Origin.
The socket echoes `hello` and validates events; it never appends them.
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
collector and NATS; it needs no database permissions. Restart discards connections; clients reconnect.
Cookies survive only while their signing/encryption configuration and expiry remain valid.
Business recovery and replay use the event-store and projection libraries.

Dependencies: Fastify, ws, and the [auth](../../libs/auth/README.md),
[events](../../libs/events/README.md), [observability](../../libs/observability/README.md)
and protocol packages, plus event-store and Zod (MIT, existing pin). PostgreSQL
(`pg`, MIT) and projections are test dependencies only; no new external component
was introduced. See the [architecture and plan](../../plan.md).
