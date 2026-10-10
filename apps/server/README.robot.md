# Server

For people, read [README.md](README.md) first.

## Memory scope and search reads

`GET /api/memory/scopes?assistantId=...&groupId=...` returns the requester's own
scope and permitted selected scopes, their audiences, separate operation rights and limits.
`GET /api/memory/:scopeId/facts?q=...&cursor=...` returns current, unexpired facts.
Session identity uses the existing member binding. Roles and labels grant no memory access.
Notes require their current assistant audience, `actsFor`, and an explicit `memory_read`
grant checked as OpenFGA `resource#use`. Missing grants deny. Only unapplied grants for the caller, their groups or the selected
assistant return 503. Grant kinds stay separate even when their ids match. Applied checks
and group checks are reused within one request and are checked again on the next request.
Reads check permission once, without a write fence or conversation history.

Queries allow 256 UTF-8 bytes after NFC normalisation and eight Unicode words.
Words contain Unicode letters, combining marks and numbers. Stored search text uses NFC too. TypeScript builds
literal full-text terms and prefixes. PostgreSQL ranks pins, exact matches, prefix rank,
then memory id. Pages contain up to 20 whole facts and 16 KiB, with no totals or sources.
A fact that cannot fit alone is replaced by `{memoryId, revision, reason: "page_limit"}`.
Destroyed and quarantined content is excluded. Expiry is compared using `Date` instants.
Signed cursors use the existing cookie secret with a separate signing prefix. They bind
requester, silo, scope, normalised query, order, scope position and projection generation.
The signed cursor also keeps the first page time, so expiry cannot shift later pages.
Changes reset paging with 409. Memory or setup-table lag and a concurrent rebuild return 503.
Scope lookup uses the same setup-table path with or without stored facts and skips old id formats.
Unknown, foreign and forbidden scopes return the same 404. Invalid input returns 422.
All responses use `Cache-Control: no-store`. Startup uses the existing database,
NATS and OpenFGA settings. Set `MEMORY_KEY_DIRECTORY` on the server and memory worker.
Without it, the server returns `{status: "unavailable", reason: "memory_unavailable"}`
with HTTP 503. The worker needs the existing directory; it never creates missing custody.
The [worker instructions](../ops/README.robot.md#run-the-live-memory-worker) cover setup.

`test/memory.test.ts` runs HTTP reads with real NATS, PostgreSQL and OpenFGA.
Set `PG_TEST_URL` to a PostgreSQL service that permits disposable databases.
`GET /api/memory/:scopeId/facts/:memoryId` returns one authorised, unexpired fact
and separately checked source statuses within 16 KiB. Unknown, foreign and forbidden
fact ids use the same 404. Expired facts also return 404. Destroyed and quarantined facts
return HTTP 200 with `{status: "unavailable", scopeId, memoryId, revision, reason}`.
The reason is `destroyed` or `quarantined`; this result contains no fact text or sources.
Older quarantined rows can have `revision: null`. Detail reads only their identity,
expiry and content status, so missing text metadata cannot turn this into a service error.
Projection lag or a changed generation still returns 503.

Source checks use existing conversation permissions before looking up content. An indexed
lookup finds one message id within the caller's latest participation period after the
conversation worker has caught up, then confirms one
event at that position in NATS. No source check replays a whole conversation.
A denied or missing source returns only `{status: "refused"}`. A service failure returns
only `{status: "unavailable"}` while the readable fact remains available. Neither result
contains a reference or preview. Member statements return the neutral label "a member's
statement", without memberId or commandId, including after the author has left.
Source checks need the server's existing chat settings and conversation read table.
No source preview is stored or returned.
Oversized authorised detail returns 503. The fresh empty runner and HTTP read test
passes with real services.
Full fresh-install memory journeys and native turns remain NOT RUN.

`POST /api/memory/:scopeId/facts` accepts commandId, text, kind, pinned, expiresAt,
sources and dependsOn. It accepts human writers only and checks Origin. Person ownership
and group membership grant write access. Notes require `memory_write` from saved grants
and OpenFGA; a read grant never supplies it. Empty sources record the writer's statement.
Chat sources are allowed only in person scopes, with message access checked separately.
Current chats cannot prove durable whole-group visibility, so shared message sources are refused.
Preferences stay personal. Text allows tabs/newlines but refuses other C0 controls.
Commands and events have separate 16 KiB limits. Dependencies require a live same-scope revision.

Write permission is checked before inspecting scope history, dependencies or sources.
Chat access is checked before an indexed message lookup in the conversation read table.
The lookup checks that the worker has caught up, then checks one saved event in NATS.
These content checks finish before the final two-second access check. The final check
watches only member, assistant, team and write-grant streams. Member and scope permission
history, and OpenFGA checks, finish before taking a database connection or command lock.
The watched stream positions are checked before taking the lock and again before append.
Each command makes one conditional append at the scope position read from history.

Each process allows four active memory writes. Each member can have at most one
active write and one queued write across all their scopes and sign-in sessions.
The member identity includes the silo, so members in different silos stay separate.
A second queued write from the same member is refused immediately. Permission history
and OpenFGA checks finish before asking for a slot or reserving a database client.
Up to eight writes can wait for at most 100 ms. A released slot goes to the oldest
waiting write whose member is free to write. Requests for a member and scope already
active or waiting are also refused immediately.
A full queue or expired wait returns 503 `{status: "unavailable", reason: "memory_busy"}`
with `Retry-After: 1`. Waiting writes hold no database client. The permission stream
positions are checked again after waiting and before taking the command lock.
A slow append holds one shared connection for that member, leaving the default
10-connection pool room for other queries. Separate server processes each have their
own limit and pool.
A PostgreSQL advisory lock keeps attempts for the same command together across servers.
Memory commands wait at most 100 ms for this lock; a busy lock returns 503. Work inside the
lock holds one database client. It reads only scope events newer than the earlier history,
with a 100 ms deadline. Refusal checks use the same read limit and the remaining write
deadline. No conversation content or OpenFGA checks run inside the lock.

The full encrypted event size is checked before a revision key is created. Changed saved
inputs return 409. Lost replies return `outcome: "unknown"`; clients check
`GET /api/memory/:scopeId/changes/:commandId` instead of resending. Status returns only
this principal's original command, after projection catch-up, including for a notes writer
without a read grant. Receipts contain references and audience, never text.

The existing 0700 key directory also holds temporary command records. Their fingerprint
leaves text out. A resolved record is deleted. Each new record stores the expected scope
position used by its conditional append. A timeout alone cannot prove failure: NATS can
still accept a delayed publish. After the append window ends, status, retry and recovery
checks release an unknown key only when the scope has advanced beyond that expected
position without saving the command. That proves the delayed append cannot succeed.
An unchanged scope stays unknown and keeps its key. Older unknown records without the
expected position also keep their keys, even if the scope advances. Prepared records
can be removed because no append was issued. Failed commands keep only the destroyed-key
marker and cannot append again. An unseen command stays unknown.
Startup launches recovery in the background. Recovery reads directory entries gradually,
yields after every 16 records and limits each scope read to one second. It reads history
before taking a database connection, then checks that the record has not changed under
the command lock. A damaged record, busy lock or event-store outage leaves the record
for a later check and never stops startup.
Keep all servers for a silo on the same database and key directory.
Fresh-install memory journeys and native turns remain NOT RUN.

The Node service exposes sign-in routes, invitation acceptance, the organisation MCP
register, a health check and authenticated WebSocket routes. It does not serve static
files: `GET /` returns 404. The [web app](../web/README.md) is built and served separately;
during development Angular's server runs on port 4200 and
proxies `/api`, `/auth` and `/ws` here on port 8080. The membership command writes only to
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
Production also requires `OIDC_EXPECTED_ORG_ID` and refuses `OIDC_EXTRA_IDENTITIES`
whenever it is set, including empty values. Development and tests may use the latter
to name exact issuer/subject exceptions; it is empty by default.
The callback is `/auth/callback`.
See [auth configuration and defaults](../../libs/auth/src/config.ts), including
client-secret indirection, scopes, cookie settings and provider claim names.
`HOST` defaults to `0.0.0.0`, `PORT` to `8080`, `LOG_LEVEL` to `info`.
`OTEL_EXPORTER_OTLP_ENDPOINT` enables optional trace export when set.
Disabling secure cookies or allowing insecure OIDC HTTP is only for local testing.

## File upload runtime licences

These packages support file inspection and upload handling in `apps/server`.
Their pinned versions and package metadata are recorded in the root lockfile.

| Component | Licence | Source or use |
| --- | --- | --- |
| ClamAV 1.5.2 | GPL-2.0 (OSI-approved) | [ClamAV COPYING](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.2/COPYING); virus scanner service |
| Copied OpenCrane 1 scanner | AGPL-3.0-or-later (OSI-approved) | `infra/clamav/upstream/LICENCE`; unmodified scanner source |
| MinIO JS client 8.0.7 | Apache-2.0 | installed package `LICENSE`; object storage client |
| file-type 21.3.4 | MIT | installed package `license`; checks file content signatures |
| yauzl 3.4.0 | MIT | installed package `LICENSE`; bounded Office ZIP inspection |
| cfb 1.2.2 | Apache-2.0 | installed package `LICENSE`; legacy Office stream inspection |
| fast-xml-parser 5.11.2 | MIT | installed package `LICENSE`; decoded Office metadata inspection |

MinIO's pinned server is AGPL-3.0. Uploads add no licence exceptions, provider SDK,
runtime data package or new computer-image package. MarkItDown is already in the
reviewed computer image.

The ClamAV service image and copied scanner have their own reviewed notices in
[`infra/clamav/LICENCES.md`](../../infra/clamav/LICENCES.md).

## Settings

The server, models and one-time bootstrap command read these environment variables.
“When needed” means a feature or connection is enabled. A process refuses to start if
one of its required settings is missing.

| Variable | Process | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `PORT` | Server | No | `8080` | HTTP port. |
| `HOST` | Server | No | `0.0.0.0` | Address for the HTTP listener. |
| `SHUTDOWN_GRACE_MS` | Server | No | `10000` | Maximum time allowed for a clean shutdown. |
| `NODE_ENV` | Server | No | None | Selects production sign-in rules and the development model-decision URL. |
| `OIDC_ISSUER_URL` | Server | Yes | None | Sign-in provider address. |
| `OIDC_CLIENT_ID` | Server | Yes | None | Client name registered with the sign-in provider. |
| `OIDC_REDIRECT_URI` | Server | Yes | None | Sign-in return address. |
| `OIDC_COOKIE_SECRET` | Server | Yes | None | Secret of at least 32 bytes for browser cookies. |
| `OIDC_CLIENT_SECRET_ENV_VAR` | Server | No | None | Name of the environment variable holding the provider secret. |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | Server | No | None | Address to open after provider sign-out. |
| `OIDC_EXPECTED_ORG_ID` | Server | Production, or with NATS | None | Organisation allowed to sign in to this silo. |
| `OIDC_EXTRA_IDENTITIES` | Server | Development and tests only | Empty list | JSON list of exact issuer and subject exceptions. Production refuses any set value. |
| `OIDC_SCOPES` | Server | No | `openid profile email` | Sign-in details requested from the provider. |
| `OIDC_COOKIE_NAME` | Server | No | `oc_session` | Browser session cookie name. |
| `OIDC_FLOW_COOKIE_NAME` | Server | No | `oc_auth_flow` | Sign-in flow cookie name. |
| `OIDC_COOKIE_SECURE` | Server | No | `true` | Requires HTTPS for browser cookies. |
| `OIDC_SESSION_MAX_AGE_SECONDS` | Server | No | `43200` | Browser session lifetime. |
| `OIDC_ORG_CLAIM` | Server | No | `org_id` | Provider claim containing the organisation id. |
| `OIDC_ROLES_CLAIM` | Server | No | `roles` | Provider claim containing role names. |
| `OIDC_STEP_UP_MAX_AGE_SECONDS` | Server | No | `300` | Maximum age of a recent sign-in for sensitive actions. |
| `OIDC_ALLOW_INSECURE_REQUESTS` | Server | No | `false` | Allows plain HTTP to the provider for local use. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Server | No | Unset | Sends tracing data to this collector when set. |
| `NATS_URL` | Both | Models yes; server when events are enabled | None | NATS event-log address, without credentials. |
| `NATS_NKEY_SEED_FILE` | Both | Yes when using NATS | None | Path to the NATS client key file. |
| `NATS_CA_FILE` | Both | Yes when using NATS | None | Path to the NATS certificate authority file. |
| `NATS_CERT_FILE` | Both | Yes when using NATS | None | Path to the client's NATS certificate. |
| `NATS_KEY_FILE` | Both | Yes when using NATS | None | Path to the private key for the client certificate. |
| `NATS_INBOX_PREFIX` | Both | Yes when using NATS | None | Prefix for private NATS reply subjects. |
| `SILO_ID` | All three | Models yes; server with events; bootstrap command | None | Id of the silo whose events and projections are used. |
| `DATABASE_URL` | Both | Models yes; server when projections are enabled | None | PostgreSQL connection address. |
| `OPENFGA_API_URL` | Both | Models yes; server with projections | None | OpenFGA permission service address. |
| `OPENFGA_STORE_ID` | Both | Models yes; server with projections | None | OpenFGA store used by this silo. |
| `OPENFGA_MODEL_ID` | Both | Models yes; server with projections | None | OpenFGA permission model used by this silo. |
| `CONVERSATION_KEYS_DIR` | Both | No | Unset | Directory of keys for private conversation content. |
| `MINIO_CREDENTIALS_FILE` | Server | No | Unset | Enables file storage with credentials read from this file. |
| `MINIO_URL` | Server | Required with MinIO credentials | None | MinIO object-storage address. |
| `CLAMD_HOST` | Server | No | `127.0.0.1` | Address of the file scanner. |
| `CLAMD_PORT` | Server | No | `43310` | Port of the file scanner. |
| `KUBECONFIG` | Server | Required for chat computers | None | Path to Kubernetes access settings. |
| `KUBE_NAMESPACE` | Server | Required for chat computers | None | Kubernetes namespace holding computers. |
| `TOKEN_SIGNING_KEY_FILE` | Server | Required with chat or budget checks | None | Path to the private token-signing key. |
| `TOKEN_ISSUER` | Both | Models yes; server with chat or budget checks | None | Name that appears as the token issuer. |
| `MODEL_DECISION_URL` | Server | No | Development URL in development; otherwise unset | Address of the models decision service. |
| `PROVIDER_SECRETS_DIR` | Both | No | Unset | Directory holding model-provider keys. |
| `MODEL_STATE_DIR` | Models | Yes | None | Directory for model gateway state and usage records. |
| `MODEL_JWKS_FILE` | Models | Yes | None | Path to the public keys used to check signed tokens. |
| `DEFAULT_PAYING_GROUP_ID` | Models | No | `installation-default` | Group charged for personal assistant use by default. |
| `MODEL_DECISION_PORT` | Models | Yes | None | Port for model budget decisions. |
| `MODEL_GATEWAY_PORT` | Models | Yes | None | Local port for the AI gateway. |
| `AGENTGATEWAY_BINARY` | Models | Yes | None | Path to the agentgateway program. |
| `MODEL_KEY_FILE` | Models | No | `.keys/.openai-key` in the repository root | Path to the gateway's default provider key file. |
| `MODEL_READINESS_PORT` | Models | Yes | None | Port used to check whether the AI gateway is ready. |
| `MODEL_UPSTREAM` | Models | No | Unset | Optional upstream address for the AI gateway. |
| `MODEL_MCP_ROUTES` | Models | No | Empty list | JSON list of tool-server routes for the AI gateway. |
| `BOOTSTRAP_TOKEN_FILE` | Bootstrap command | Yes | None | Private file where the one-time token hash and expiry are stored. |

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

Session routes and `/ws` use `isOrganisationSession`. Routes that already report
503 without `OIDC_EXPECTED_ORG_ID` keep that response. Without that setting,
`/ws` and `/auth/logout` refuse valid sessions with 403, and `/auth/me` reports
`authenticated: false`. Development sign-in still works without the setting.
The first-owner claim uses the stricter installation-organisation check.

`test/organisation-check.test.ts` scans all server source files. It refuses calls
to `isIdentityAllowed` outside `auth/routes.ts` and requires an
`isOrganisationSession` call in each API route file. It reads TypeScript syntax,
so imports, comments and strings do not count as calls. The first-owner claim is
an explicit exception; `/healthz` is public and outside `/api`.

`GET /auth/login` redirects to the provider; `GET /auth/me` reports the session,
including the optional signed-in profile `user.name` for display.
`POST /auth/logout` requires the exact configured Origin and a valid session for
the pinned organisation. Refusals clear no cookies. Success clears the local cookie
and answers a top-level form POST with **303 See Other**. Its `Location` is the
provider end-session endpoint with `id_token_hint`, `client_id` and the configured
`post_logout_redirect_uri`; the response body is empty and marked `no-store`.
The ID token stays out of JSON, page JavaScript and logs. If provider logout is
unavailable (including older cookies without an ID token), a plain-text page says
only the OpenCrane session ended. `/auth/me` never returns the token.
Zitadel ends **all accounts in that browser**, returns without a chooser and
requires credentials on the next sign-in (which may first select a remembered
account); see the [live evidence](../../docs/process/signin-evidence.md).
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
then checks current Owner/Admin events and the silo's `admin` permission through OpenFGA.
Cookie roles are ignored.
Ambiguous or absent identity bindings are refused. Old unbound joins need a bound
invitation before they can subscribe. Permissions are checked on each drain and
independently every 250 ms. A 1.5-second watchdog stops hung checks. Delivery
requires an unexpired access check, even while content is slow. Event-based
demotion or removal sends `refused` and closes; dependency failures close with
1013 during polling. Session expiry is checked there too. Members use the narrow
colleague read, which has no emails.

Version 1 replies are `member`, `ready`, `resync` or `refused`; every reply has
`topic`, `version`, `generation` and a safe integer `position`. A `member` contains the full row
at that position. Positions are global event-log sequences filtered to this silo's
members changes, so numeric gaps are normal. Apply rows in order, remember the
last applied position and reconnect with it. `ready` marks initial catch-up.
Positions ahead of the projection are refused. A resumed cursor includes the
generation from its last reply. A repaired replay bumps the generation, sends
`resync` at position 0 and closes with 1013; reconnect from 0. The original demo messages remain
separate from this versioned subscription protocol.

PostgreSQL delivers `members_changed` NOTIFY only after the projection transaction
commits. Its payload is a wake-up, never data or permission: the server rereads
ordered changes in pages of 100. A failed LISTEN connection fails subscriptions
closed; restart the server to restore it. Reconnect always rereads durable history.
Changes have no pruning yet. An equal online rebuild keeps its generation,
so clients retaining positions can resume without reloading.
Multi-replica fan-out over NATS core is **not implemented**.

## Organisation integrations

`GET /api/org/integrations` requires the encrypted session cookie, the configured silo and
organisation, a joined issuer/subject binding in the members projection, and current
OpenFGA `admin` permission (which includes owners). Cookie roles are ignored. Missing or
unavailable authority fails closed. The response follows `integrationsResponseSchema`:
event-derived server/source/tool/status rows plus `loadedAt`. Discovery metadata supplies
the server name and version when present, and registration keeps optional catalogue origin
separate from the remote/hosted transport kind. Old events replay with derived labels and
explicit “Version not provided” / “Not provided” copy rather than invented facts.

`DATABASE_URL` and the existing OpenFGA settings enable this route as well as members
realtime. The `mcp catalogue` projection must run separately; the server remains a
read-only projection client. The real-service test creates disposable PostgreSQL 17
databases and uses real NATS and OpenFGA:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run apps/server/test/integrations.test.ts
```

That suite also drives Chromium through Angular's development proxy into this route.

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

For real Zitadel sign-in on the tailnet URL, use the [dev stack](../../infra/dev-stack/README.md).
Browser callback refusals clear both cookies and redirect to `/signin/rejected` with
one fixed reason code. API clients still receive 400 JSON. Provider discovery
failure also reaches that screen. `/auth/me` refuses expired sessions and sessions
whose organisation no longer matches the configured pin or an exact configured identity.

## Conversation core

With `CONVERSATION_KEYS_DIR`, the server exposes `POST /api/conversations`
(`id`, `conversationId`, `assistantId`, `mode`), `POST /api/conversations/:conversationId/messages`
(`id`, `text`, optional `executionMode: "memory_free"`), and GET on those paths.
The caller supplies stable event ids for
retries. POST requires the session's exact Origin. Only live silo members acting
for their personal assistant can create; conversation participants can read/post.
Owner/admin roles do not bypass private conversation access. List/messages reads
come from the `conversations` projection; text is decrypted only after permission
checks. The messages response contains ordered event rows, a position, generation,
`computerState` (`ready`, `starting`, `recovering` or `not_applicable`),
`computerRecovered`, and the optional `computerLostAt` time. A lost computer stays
recovering until a new `computer.ready` event appears. A fresh ready computer sets
`computerRecovered`.

On `/ws`, subscribe with `{type: 'subscribe', topic: 'conversation', conversationId,
since, generation}`. Apply event rows by position; deltas append to their message
id, completed messages replace that message's text. `ready` marks catch-up;
`resync` requires restarting at position 0. Keep the last applied position and
generation when reconnecting. The server rechecks permissions throughout a stream.

The bridge runner also needs `KUBECONFIG`, `KUBE_NAMESPACE`,
`TOKEN_SIGNING_KEY_FILE` and `TOKEN_ISSUER`. The dev host uses a loopback Kubernetes
proxy with scoped Pod-proxy permission. Its separate `x-bridge-token` capability
never replaces Kubernetes authentication. Per-conversation AES-GCM keys live in
the private dev secret-store directory, outside events and projections. Preserve
those keys with event backups; deleting a key makes that conversation’s event/projection text unreadable.
[Qualification and limits](../../docs/process/bridge-evidence.md).

Creation defaults omitted `mode` to `agent_session` and records it immutably in
`conversation.created`. Direct creation binds exactly two active silo members and
no assistant. Unsupported modes return HTTP 400. The projection retains mode
on replay; older stored events without mode read as `agent_session`. New commands
always write mode. Changing creation arguments on a retry never changes the conversation.

Each conversation thread has an ordered report queue: at most 64 reports and
1 MiB, including the report being persisted; at most 64 queues per connection.
Exceeding either bound closes with 1013, “Report queue limit”. Threads acknowledge
independently. Reports retain global ids and per-conversation predecessor positions;
reconnect starts at the largest contiguous committed global position. Committed
payload digests are checked on both append and deduplication. Acknowledgements
name one report and never release another thread's pending start.

The start acknowledgement carries a fresh signed thread grant after a separate
server lifecycle command has acquired the computer-stream suspend fence. Each
command still makes one conditional append. Terminal reports trigger permanent
server closure, recovered by the watcher if the server stops between those commands.

## Tools offered with a chat turn

The bridge reads server ids from the MCP catalogue projection. It considers only
published rows, then reads each server's `mcp-<id>` stream once. It builds the current
policy and finds the latest discovery from those same saved events. It keeps a server
only when it is published, uses `accountMode: none`, and both the requester and
assistant have the `use` grant.
The tool list is sent only for a personal assistant's memory-free turn. Team turns,
private turns and turns without a binding get no list.

The bridge joins the saved discovery definitions to the current tool policy by name
and revision. It sends each tool's `allow` mode alongside its definition. It sends only reviewed
tools in Allow mode with `costCents: 0` and a
stored definition. Ask and Block tools, missing definitions and server discovery
results are left out. In particular, `discoverResult` is never sent because it may
contain instructions that nobody reviewed.

Each server is named `oc_` followed by the first ten hex digits of its SHA-256 id.
The bridge adds whole servers only. It skips ids that the computer would refuse,
server information over 200 characters, definitions over 32 KiB and duplicate keys.
The tool list is capped at 48 KiB and at 20 servers. It is also capped so the JSON
turn stays below 120 KiB, leaving room below the computer socket's 128 KiB limit.
The bridge counts the encoded turn, including its text and attachments, before
choosing tools. It logs how many servers did not fit.

The bridge saves the selected list beside that message's sent-turn record. A build
has a one-second limit. If the catalogue, event log or OpenFGA cannot answer, the
bridge logs one fixed reason, saves an empty list and sends the turn without `tools`.
One-second resends reuse that result, so a waiting turn does not repeat catalogue,
event-stream or OpenFGA reads. The list is an offer to Codex only. The gateway checks
every call again against current grants and tool rules, so a grant removal or a
change to Block still refuses a call after the turn starts.

A digest-matching start replay for an already closed turn is acknowledged without
new admission or a turn grant, including recovery after a terminal report but
before its lifecycle closure. Older journals without `previousSequence` replay
in global computer order and check continuity across conversations.

Permanent report refusals close with 1008 and a safe reason. The watcher logs the
computer id and reason, then stops reconnecting that computer for its lifetime;
other computers continue. Resolve the refused report before restarting the server.
Transient persistence failures still close with 1011 and retry from durable history.
Credential expiry closes with 4001 and reconnects with a fresh credential; only a
recorded report refusal stops automatic recovery.

### Chat UI reads and Stop

The [direct chat API](../../docs/api/direct-chats.md) supplies two-person creation,
messages, history, status and live updates. Direct messages never start assistant work.
Direct reads and posts return 425 `access_applying` when a recorded participant is
waiting for creation permissions. Current membership and recorded participants are
checked first. Applied permissions, missing chats and nonparticipants keep their
normal 403 refusal. Status reads keep their existing `allowApplying` behaviour.
History and status check access once before reading content. The list checks each
row's participants and OpenFGA permission once, with eight rows at a time.
Readers do not use an authority fence, the short check that detects access changes
before a write. Content reads can take longer than two seconds without an access timeout.
Socket polls run every 100 ms. Each socket keeps the conversation's creation facts.
Each poll checks the conversation feed position, projection generation and computer
record position with one small query. It reads chat rows and computer state only when
one of those values changes, then keeps the computer state for the next tick. This keeps
new messages and computer changes within the existing poll delay without repeating the
content queries on an idle page.
The server shares the OpenFGA client for each silo and permission model. It checks
access at subscription, then calls OpenFGA again only when a watched access record changes.
It watches member and participation stream positions and, for a team assistant, its team stream.
Personal sessions never watch conversation history for access. Initial participants are recorded
when a chat is created. Chat sockets watch later changes on the small participation
stream. Chat, live view, file and approval access check those saved changes before
OpenFGA catches up.
Each access poll has a 1.5-second limit and ends before reading content. Access
polling continues during a slow content read, so a member-stream removal still
closes the socket within two seconds without waiting for OpenFGA to apply it.
The first access check closes with 1013 if OpenFGA has not applied a change yet.
After a successful check, a later unapplied change keeps the socket open but pauses
message delivery while each poll checks again. If it stays unapplied for five seconds,
the server closes with 1013 so the browser reconnects. A member or team removal is
checked before this wait and still closes with 1008 within two seconds.
Reads use no authority fence. Writes read history with its own ten-second limit
before opening their short access check.

`GET /api/chat` returns the authenticated member id and their personal assistant
id (null while provisioning). It requires live silo membership and `acts_for`;
it does not expose the organisation computer register. Conversation list rows
include an event-derived title and status, computed only after per-conversation
read permission. No administrative bypass grants access to private sessions.

`POST /api/conversations/:conversationId/messages` also accepts
`{id, stopTurnId}`. Only the original message author can stop that turn. It appends
one `agent.turn_stop_requested` event; retries retain their event id. The bridge
skips an unstarted stopped turn or interrupts its active Codex turn. The browser
freezes displayed text at the stop event's position, including after reload;
late reports remain in durable history without replacing that displayed partial.

Owner/Admin budget configuration uses POST `/api/org/models`, forwarded to the
single-writer actor with a short-lived signed command. Set `MODEL_DECISION_URL`
and the existing `TOKEN_SIGNING_KEY_FILE`/`TOKEN_ISSUER`. In development, the URL
defaults to `http://127.0.0.1:43001`. On a fresh stream the model process records
`installation-default` as its explicit personal paying group; installation can
override that seed with `DEFAULT_PAYING_GROUP_ID`. Stored defaults always win.
See the [budget contract](../../libs/models/README.robot.md#monthly-budgets-p3-13).

### Permission-scoped audit (P3-19)

`GET /api/conversations/:conversationId/history` requires live membership,
conversation read permission and returns only that requester's actions.
`GET /api/org/history` requires live Owner/Admin membership and returns safe
organisation metadata. Neither route decrypts text or approval details, nor returns
credential references, bearer material, raw arguments or gateway diagnostics.
For organisation history, the server checks the member's role before reading a
page. It checks OpenFGA permission after the page is read. For conversation
history, it reads the page before checking access. PostgreSQL gives each query a
one-second limit.
The access check reads only member and ownership history; it never reads the
conversation event stream or rejects the result because ordinary chat activity
arrived during the read. A missing membership receipt or permission outage refuses
the request. No audit read scans global event history.

Filters: `requestId`, `turnId`, `decision` (`allow`, `ask`, `deny`) and `before`
(an exclusive event-position cursor). Pages contain at most 50 anchors with all
relevant evidence; decision and observed outcome are separate. An allowed request
without an observation reads `unknown`, never success. The
[shared response contract](../../libs/protocol/src/audit.ts) is strict and permits
only fixed readable reasons. Run the `audit` ops worker alongside the existing
projections. API startup enables these reads with the existing event store,
database, member feed and OpenFGA settings; no conversation encryption key is needed.

Tests: `PG_TEST_URL=… npx vitest run apps/server/test/integrations.test.ts
apps/server/test/audit-browser.test.ts`. Browser evidence covers 1280/390px and
Loading/Empty/Unavailable/Outcome unknown with keyboard filters. Fresh-install
qualification is NOT RUN; this change does not alter or operate a dev stack.

The P3-2 approval endpoint is `GET|POST /api/conversations/:conversationId/approvals`.
GET restores safe decrypted cards and a session/conversation-bound CSRF token; POST
accepts only `approvalId` and `decision` (`approved` or `rejected`). It requires the
requester's authenticated session, current authority, exact Origin and `x-csrf-token`.
409 means the decision lost its conditional append; 428 requires step-up; uncertain
transport or persistence needs Check status, never an automatic repeat of an effect.
A required step-up uses `/auth/login?approval=<id>&returnTo=<local-path>`, OIDC
`prompt=login`, `max_age=0`, and verified `auth_time` within five minutes. The flow
binds the original cookie, requester and approval; missing, future or stale evidence
refuses. The resulting session authorises only that approval's step-up check.

Run the gateway/API tests with:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/approvals.test.ts
```

After building the web app, set `APPROVAL_BROWSER=1` for the same command to include
Chromium at 1280/390px.
These fixtures create disposable NATS/OpenFGA instances and private Postgres databases.
They do not use the shared dev stack or a paid upstream.

The model process accepts optional `MODEL_MCP_ROUTES`, a JSON array of
`{serverId, connectionId, upstream}` records, to configure the existing gateway
MCP routes. The default is empty. Deployment configuration owns these destinations;
callers cannot supply them. Set `CONVERSATION_KEYS_DIR` to the same private directory
as the server so the decision process can encrypt and verify approval reviews.
The dev stack routes its credential-free recording fixture to its loopback stub.

Read-only desktop sessions use `POST /api/conversations/:id/view` and
`/ws/conversations/:id/view` for the WebSocket. The POST requires the session, exact Origin and
`x-opencrane-view: 1`; redeem its ticket once as WebSocket subprotocols
`binary, <ticket>`, with the same session and Origin. Both conversation participation
and an explicit shared-desktop grant are required. The server uses `KUBECONFIG`
and `KUBE_NAMESPACE` for its private Pod stream. See the
[live-view contract and evidence](../../docs/process/live-view-evidence.md).

Live-view access checks run every 250 ms with a 1,200 ms deadline. An explicit
`member.removed` result or conversation-read denial ends the check immediately,
without waiting for sibling reads. These denials close the viewer with 4003 and
`access_changed`. Remaining reads keep error handlers attached after the check ends.
An unavailable read or a timeout still grants no new lease. An existing lease
allows desktop bytes for at most 1,500 ms from its successful check's start.
Ten seconds without a valid lease closes the viewer with 4503.
The exact `Authority changed` error means a watched stream changed during a check;
it leaves access unconfirmed. The next check closes the viewer if access really ended.

The `live-view-activity`, `live-view-unavailable`, `live-view`, `live-view-delays`
and `view-lease` tests cover these decisions. They include a held desktop read
during member removal, continued frame delivery attempts, and a conversation denial
beside a slow unavailable desktop read. Fresh-install qualification is NOT RUN
for this change.

## Remote MCP registration (P3-3)

Owner/Admin `POST /api/org/integrations` accepts `{locator}` with the exact session
Origin. It conditionally appends one registration per normalised HTTPS source and
returns `{serverId, changeRef}` with HTTP 202. Repeating the same source, including
concurrent requests, returns the same reference. GET
`/api/org/integrations/:serverId/discovery` reads event-backed status and immutable
inventory. GET `/api/org/integrations/discovery?locator=<encoded-source>` reconciles
a lost registration reply without creating anything. Both require current admin
access. HTTP 400 refuses the source; 503 is an unknown outcome requiring status.

With the existing event store and catalogue configuration, `main.ts` starts the
install worker. Its expiring in-memory identity alone admits POST
`/internal/mcp/:serverId`, bound to that registered server and limited to
`server/discover` and `tools/list`. Computers have no such identity. This route
selects its endpoint from events, strips caller headers and never invokes tools.
Restart reconciles unfinished registrations; terminal evidence is never rediscovered
by this worker. PostgreSQL replay only rebuilds the register.

The OC1 guarded transport source is commit `10abd0ef6182f36bec13d8f1358e43b15ead7cd5`.
Every HTTPS connection checks all DNS answers, pins its checked address and verifies
the original TLS hostname. IP URLs, credentials, queries/fragments, redirects,
private/reserved addresses and session/legacy MCP are refused. MCP 2026-07-28 and
complete discovery metadata are mandatory. Per-request fields use `params._meta`
with `io.modelcontextprotocol/protocolVersion` and `clientCapabilities`; server identity
comes from `result._meta['io.modelcontextprotocol/serverInfo']`. The full locator query
is redacted before authentication or validation. Limits: 1 MiB request, 4 MiB response,
30 seconds for the whole discovery including DNS, ten pages, 100 tools/page and
1,000 tools total. Definitions are at most 32 KiB each and 512 KiB together;
discovery metadata is at most 64 KiB and the inventory event payload 900 KiB.
Duplicate accepted tool names, duplicate JSON keys, malformed page envelopes and
repeated cursors reject the inventory. Individual malformed Tool declarations are
excluded; valid siblings remain available for review. This follows the explicit
per-tool rejection rule for `x-mcp-header` in the
[MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header)
and applies the same isolation to other invalid declared fields and schemas.
`rejectedTools` records only a safe name (when valid), the definition digest and a
fixed reason code; it never stores rejected definitions or upstream validation errors.

Input schemas require an object root. Output schemas may describe arrays, scalars
or unconstrained values (`{}`). Accepted definitions are stored as immutable JSON
strings, including output schemas and extension fields; the complete definition
contributes to its revision and the inventory digest. Ajv 8.20.0 (MIT, licence
checked locally) validates JSON Schema 2020-12 (default) and draft-07 without
fetching references. Unsupported dialects and unresolved references exclude the tool.
Header annotations require token names, no control characters, case-insensitive
uniqueness and only declared string/integer/boolean types. They may appear only
along a chain of `properties` keys from the input root. Integer argument range
checks belong to the later call path; discovery never invokes tools.

Discovery leaves tools blocked and unpublished. Protected servers show Needs input
until P3-9; publication, grants and calls are outside this ticket. The local HTTPS,
DNS rebinding and browser fixtures use no external MCP endpoints. Run
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/inventory.test.ts apps/server/test/mcp-discovery.test.ts apps/server/test/integrations.test.ts --maxWorkers=2`.
See the [qualification receipt](../../docs/process/p3-3-mcp-discover.md).

## Conversation uploads

The [upload API](../../docs/architecture/upload-api.md) documents raw-byte POST
and replayable GET on `/api/conversations/:conversationId/files`. Enable it with
the chat configuration, `MINIO_URL` and `MINIO_CREDENTIALS_FILE` (a rotating,
bucket-scoped STS lease); `CLAMD_HOST` defaults to `127.0.0.1`, `CLAMD_PORT` to
`43310`. Provision private `quarantine` and `files` buckets and run the `files`
projection separately. The computer receives clean bytes through the server's
bridge and holds no object-store credentials. [Evidence and qualification](../../docs/process/upload-evidence.md)
cover real-service tests and the pending fresh-install journey.

## Authorised screenshots

`POST /api/conversations/:conversationId/screenshots` takes no body. Supply the
session cookie, exact configured Origin, `x-opencrane-view: 1` and a stable
`idempotency-key`. Current participation and the shared-desktop audience grant are
checked against events and OpenFGA, before capture and again before saving. The
existing namespace-scoped authenticated desktop proxy supplies one framebuffer;
there is no caller-selected URL, path or encoding. Dimensions are at most 4096
per axis and at most 4 MiB of raw pixels, with a ten-second framebuffer deadline
and at most four concurrent captures per server.

A clean scan stores a PNG using the existing 20 MiB file path and appends one
`file.uploaded` with capture metadata. Success is 201; input, access, scan and
capacity failures return 400/401/403/422/503, and append conflicts return 409. Retry
an uncertain command using the same key. Participants reopen screenshots through
the authenticated file-view endpoint; ordinary uploads retain creator-only access.
No Kasm credentials, public image URL or signed object-store URL reaches the browser.
Enable both existing desktop and upload configurations; no new dependency is added.

Run `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/screenshots.test.ts --maxWorkers=2`.
After the web build, `SCREENSHOT_BROWSER=1` with the same database runs
`apps/server/test/screenshot-browser.test.ts` against disposable real Kasm, scan
and storage fixtures. It requires the existing `ocn-upload-computer:test` image.
See the [P3-18 evidence](../../docs/process/p3-18-screenshots.md) for remaining qualification.
Owners and Admins can list and inspect monetary uncertainty with
`GET /api/org/effects` and `GET /api/org/effects/:permitId`, then submit attested
receipt evidence with `POST /api/org/effects/:permitId/resolve`.
Both GET routes read the saved spending records with their own ten-second limit,
then check current membership and OpenFGA once before returning them. A removal
during the read returns 403 even if the member table and OpenFGA are still behind.
POST reads budget and effect history with its own ten-second limit before starting
its two-second access checks. It rechecks both HTTP and event-backed membership
immediately before its unchanged conditional append. Removal during history refuses
the write even when the member table and OpenFGA have not caught up.
[The resolution contract](../../docs/process/p3-15-reconcile.md) specifies the
CSRF token, optimistic sequence and pending settlement state. No screen is added.
Flat group administration is available through the [groups HTTP interface](../../docs/api/groups.md).

## First-owner bootstrap (#12)

A production install generates one random 256-bit token with a 24-hour expiry:

```sh
SILO_ID=acme BOOTSTRAP_TOKEN_FILE=/var/lib/opencrane/bootstrap/token.json \
  npm run bootstrap-token -w apps/server
```

Run under the server's Unix account. The command creates a private directory
(0700) and file (0600) outside the repository, writes only a SHA-256 hash, silo
and expiry, syncs it, then prints the token once to stdout. Run in a private
terminal with output capture disabled; never put the token in argv, a URL, logs
or events. An existing file is refused, so repeated installation cannot rotate
credentials silently. For an expired or lost token on an unclaimed silo, the
operator may remove that private file and rerun the command. Event history still
prevents a new claim after any membership history exists. Back up the event store;
losing this hash file after a successful claim does not reopen bootstrap.

Set the same `BOOTSTRAP_TOKEN_FILE` and `SILO_ID` on the server, along with its
existing NATS credentials and required `OIDC_EXPECTED_ORG_ID`. The server reads
this file only during an unclaimed installation, verifies private permissions
and ownership, and fails closed on missing or invalid material. It does not
write business state to the file or PostgreSQL. Open `/claim`, sign in through
Zitadel, enter a display name, contact email and token, then choose **Claim this
silo**. Email is contact data; the encrypted authenticated session supplies the
identity. The token input clears after submission and is never saved in browser
storage. A successful claim returns HTTP 201 and records one event; reactions
provision the personal assistant, owner/member OpenFGA tuples and model grants.
The model process seeds `installation-default` (or `DEFAULT_PAYING_GROUP_ID`)
as the default personal paying group using its existing budget events.

`POST /api/silo/claim` accepts only `{token, displayName, email}` with an exact
same-origin session. The token creates the first owner of a fresh silo: any
membership history, including pending invitations and removed members, disables
this path. An existing member cannot use it to gain ownership. This follows the
owner decision on #12; it is not a recovery or promotion command.

Identity bindings live on member streams. The same conditional append requires
expected sequence zero across `member-*`, including every identity's binding
stream, using NATS' native subject-filter expectation. A membership write between
the history read and append therefore refuses the claim without recording an
event or consuming the token. No projection freshness is needed for this check.

Refusals include `token_used`, `owner_exists`, `members_exist`,
`token_expired`, `wrong_token`, `wrong_organisation`, `concurrent_claim`,
`no_session`, `wrong_origin` and `invalid_request`. Five submissions per minute
share a process-wide installation budget across identities; HTTP 429 carries
`Retry-After: 60`. This bounds failed attempts and in-flight races. Deployments
with multiple server replicas must also apply a shared ingress rate limit.
HTTP 503 means the outcome is unknown; do not assume ownership or repeat effects.
A later submission consults event history and cannot create a second owner.
All claim replies use `Cache-Control: no-store`.

The existing dev stack retains its explicit invitation/join owner bootstrap
for `jente@elewa.ke`; see its [instructions](../../infra/dev-stack/README.robot.md#zitadel-sign-in).
This production token path never uses the dev external-identity exception.
Ownership transfer remains #24. The production install uses the token method alone.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run apps/server/test/bootstrap-token.test.ts apps/server/test/bootstrap-claim.test.ts apps/server/test/bootstrap-browser.test.ts --maxWorkers=2
```

Tests use disposable NATS, PostgreSQL and OpenFGA plus Chromium at 1280/390px.
[Evidence and remaining live qualification](../../docs/process/bootstrap-token-evidence.md).

## Idle polling

The chat watcher checks the global event position every 250 ms. It skips conversation
and computer history when that position is unchanged and the last pass found no
pending message or file. The conversation table must have processed that event
position before idle skipping starts. A failed read or pending work keeps retries enabled.

During a pass, sessions share their assistant's computer history. The watcher checks
that stream's latest position first and reuses the saved history when it has not
changed. The assistant's kind is saved after its first successful read because it
cannot change. A failed creation read is logged once for that assistant and never
allows delivery with an unknown kind. Only a waiting message keeps that chat pending.
An assistant without a computer waits for its computer stream to change before its
unchanged chats are read again. This does not keep the 250 ms polling loop busy.
Created and closed chats are read together through an index on the organisation and
event type, so each pass does not scan every reply row twice.

The watcher remembers each chat's last stream position. It skips
unchanged chats unless delivery is waiting for the computer to accept a turn,
uploads remain, the computer changes, or the connection closes. A failed read does
not save that chat's position, so retries still read it. Closed or unlisted chats are
removed from the cache. The cache stores connection numbers and releases closed sockets.
Each connection remembers the last turn sent for each chat and when it was sent.
An unaccepted turn is sent again at most once per second on that connection. Resends
stop when `computer.turn_started` records acceptance. New Stop requests still reach
an accepted turn. A new
connection sends pending turns again, including turns already accepted before the
connection closed. These are delivery checks; turn admission keeps its separate
access checks on the small streams that grant permission.
When a final report appears before its turn close, recovery checks the computer
history again before issuing another close command.

The first pass after restart always runs. Failed event-position or table reads are logged
and retried after 250 ms. An unexpected watcher failure logs a fatal error and exits
the server with status 1 so its supervisor can restart chat delivery.

The models process keeps one usage-file byte
offset for its 100 ms ticks. Each tick also checks NATS metadata so an idle
process still detects an outage and restarts after the existing 15-second limit.

## Private team turns

Team messages default to restricted execution. Only `executionMode: "memory_free"`
selects shared tools and persistent thread state. Personal turns stay memory-free.
Admission checks modes and private thread reuse before opening the existing four
small access streams. Context is rebuilt after admission with the ten-second chat
history budget. It contains only the requester's earlier completed exchanges,
up to 24 KiB, and time-only records of unfinished work. It is never stored.
The [HTTP contract](../../docs/api/shared-assistants.md#private-turns-and-memory-free-turns)
and [check record](../../docs/process/p4-14-private-turns-evidence.md) give the details.

## Personal paying group summary

Personal turn admission uses the event-store `budget-payer` summary with `keep: 4`.
It parses each `budget.ceiling_set` with the existing `budgetDetails` schema. The
newest global ceiling event with a default paying group supplies the payer. Scoped
ceilings and global ceilings without a default do not replace it. No default still
raises the existing `ReportRejected` message. Each admission catches up first,
outside its access check. A warmed summary reads only new budget events.

`test/personal-payer.test.ts` covers changed defaults, skipped scoped ceilings,
missing defaults and at most two new budget rows after warming a 500-event stream.
`test/integrations.test.ts` covers resolution after a long history read and member
removal during that read, through the real HTTP route and disposable services.

## Chat summary and report writes

Reports and turn commands share the server's `chat` summary, built on the event
store's stream summary. The server keeps up to 64 conversations per store connection and rebuilds a dropped summary from
the first event. Each call reads through the latest saved event before copying
its facts. History reads have their own ten-second limit and finish before turn
admission starts its access check.

The summary keeps the first conversation creation, the first message's raw author
and execution mode for each event id, closed turn ids, and report positions by
computer and report sequence. It keeps no message or reply text. The newest stored
report supplies that computer's last report sequence; the first matching report
supplies the replay position. Callers parse the copied fields with the existing
schemas. Replies without `previousSequence` still use the whole-log
`reportPosition` check for old journals.

`recordReport` checks a repeated report by reading its saved position. A verified
repeat returns `duplicate` without calling `append`. A new report passes
`historyChecked: true` and the summary's sequence to the unchanged conditional
append. It checks the digest of the event at the returned position, including its
id, and keeps the existing refusal messages.

`turnCommand` uses the copied creation, requested message and closed status.
It also uses the shared auth `computer` summary for readiness, turn bindings,
start command keys and thread checks. It copies these facts and the position
in one `take`, before any access check. The conditional append names that position.
A repeat returns the first start binding without an append. A closed turn skips
its append. A start from another computer still writes its own start. A new write
checks the binding and id of the one event at the returned position; a missing or
different event gives `Turn binding conflict`.

PR #238 shipped the start-repeat skip and `turnCommand`'s `historyChecked` opt-in.
PR #246 moved that check onto `startCommandKeys` in the shared computer summary.
Model decisions now use that summary and their own chat summary too.

`test/chat-summary.test.ts` uses real NATS to check warmed 500-event chats,
report and turn repeats, old journals, changed payloads, user posts between reports,
closed turns and missing or different events at an append's returned position.

Before the retained-fact budget was added, a local memory measurement used Node with `--expose-gc --max-old-space-size=256`.
A synthetic reader supplied all 64 cached chats with 3,000 events each: one creation,
500 messages, 500 closed turns and 1,999 reply chunks. Message and chunk rows carried
32,000-character text. After collection, the summaries retained 13,240,040 bytes
(12.6 MiB); total JavaScript heap use was 27,932,112 bytes (26.6 MiB). This measures
summary storage, not the complete server running on a live silo.

## Computer state in chat replies

Chat feed reads use the `computers` projection for state, the last loss time and the
recovered marker. They never read lifecycle history. Existing installations need a
computers rebuild before serving these routes. Assistant kind is joined into the list
query. `test/chat-http.test.ts` checks the response fields, cold resume and lost list status.

The recovered marker describes the computer. The browser shows the lost-request notice
only if this chat's last agent turn is lost or failed and ended at or after the last
computer loss. A later completed turn removes that notice.

Report positions grow with every stored reply because repeats must find and check
their saved event. The chat summary now has a 32 MiB estimated memory budget as
well as the 64-chat count limit. Compact report positions count separately from
messages and closed turns. Larger active sets can still cause rebuilds (#256).
Issue #253 concerns the whole-log `reportPosition` read for old journals and
reconnection; it does not reduce this summary's storage.

## Turn admission read growth

`test/turn-admission-cost.test.ts` measures `recordReport` for the start,
`turnCommand`, `credentials.turn` and `BudgetActor.reserve` together. It uses real
NATS, one personal assistant, and 10, 100 and 500 earlier turns. It checks both
new chats and a chat seeded with 500 events. Fixture events use conditional
appends with `historyChecked`; warm-up and fixture reads are outside measurement.
Reports send `previousSequence`, so the old-journal whole-log read is excluded.
Each measured admission rejects whole-stream reads and checks that rows at 500
are no more than rows at 10 plus two. Times are logged, with no timing assertion.

`test/computer-turns.test.ts` covers warm starts, closes and repeats after 500
turns, unchanged refusal messages, first bindings, newest execution modes and
missing or different read-back events. It also injects suspension during admission
to prove the append still uses the position read with the facts.

## Tool call feed records

The strict report parser accepts `agent.tool_call_started` and
`agent.tool_call_finished`. Both require conversation id, turn id, call id,
server id and tool name. Finished reports require completed/failed status and
allow a non-negative integer `durationMs`. Unknown fields are refused. Each
report uses the existing conditional append and computer sequence digest; an
identical replay is a duplicate and changed bytes are refused. Reports grant
no access and carry no arguments, results or error text.

Tests: `test/tool-reports.test.ts` checks valid provider punctuation, repeated
reports, invalid fields and forged assistant/conversation/turn references. A
refused report leaves the event log unchanged. The approvals GET regression in
`test/chat-access-regression.test.ts` adds each tool event during its access
check. It expects 200 and returns 503 if that type leaves `outputReportTypes`.
`test/bridge-channel.test.ts` checks that the computer skips invalid tool fields
and keeps sending later reports through its open socket.

## Retained chat summary budget

The server chat kind keeps at most 64 chats and estimates up to 32 MiB across
them. Each message counts as 256 bytes, each closed turn id as 128, each computer
report tracker as 256 and each compact report position as 64. The counts are
updated as events arrive, so checking the budget does not scan old reports.
These allowances leave room above the UUID measurements below. The shared
computer kind has a separate 48 MiB estimate. Together they allow 80 MiB, leaving
176 MiB of the 256 MiB heap cap for other server work and active reads.

Older whole summaries are dropped and rebuilt on their next use. A summary larger
than the whole budget is dropped on its own, leaving other chats warm. Closed
turns, report repeats and thread ownership checks still use complete facts.
Reads in progress and caller copies are outside the retained-cache estimate.

`test/chat-summary-memory.test.ts` checks that 600 replies of 300 chunks each
stay warm. Recording and repeating the next report use only tail reads. It also
checks that an oversized map is dropped and still finds its first saved report
after rebuilding.

`test/chat-summary-memory.ts` measures the real summary with rows created on
demand. Ids are UUIDs and correlation fields contain request, conversation and
turn ids. Messages carry 32,000-character placeholders; reply chunks carry 128.
Node 22.23.3 runs with forced collection and a 256 MiB heap cap. Retained bytes
compare collected heap before and after releasing the store. Heap is sampled
every 100 positions and at the end of the build, before the final repeat read.
The sampled peak can miss shorter peaks and does not measure a live server.

| Shape | Retained cache bytes | Total heap bytes | Sampled peak heap bytes |
| --- | ---: | ---: | ---: |
| Two chats, 600 replies each, 300 chunks per reply | 15,073,288 | 30,393,552 | 47,563,336 |
| 64 chats, 500 turns each, three chunks and a close per turn | 12,993,752 | 28,571,056 | 49,147,824 |

The long-reply shape stays warm and uses about 41 bytes per kept fact. The
64-chat mix uses about 68 bytes per fact. Report positions keep the smaller
allowance because messages and closed turns have their own counts.

```sh
nice -n 10 npm run measure:chat:memory -w apps/server -- 2 600 300
```

The arguments are chats, turns per chat and reply chunks per turn.

Rebuild cost for larger active working sets is tracked in #256. The remaining
approval history and polling reads are tracked in #254 and #255. Fresh-install
governed-work qualification remains tracked in #63.

## Member reads

Bound invitation acceptance copies `personalAssistant: provision|none` into
`member.joined`; an older invitation without a choice records `provision`.
The strict join request cannot override it. The join receipt proves membership,
not assistant creation or computer readiness. The assistant reaction runs later.
`test/member-joined.test.ts` covers choice, repeats and lost replies on real NATS.
Email-only acceptance records the account issuer and subject in the join event.

Email create/renew and original-command status follow the
[member API](../../docs/api/members.md#create-and-renew-email-invitations).
`test/invitations.test.ts` uses disposable NATS, PostgreSQL and OpenFGA for
current access, strict input, renewal, repeats, lost replies and slow history.
Email invitations have no account binding until the join route accepts them.

The [API contract](../../docs/api/members.md) defines member header/directory access and limits.
`test/realtime.test.ts` covers real HTTP, privacy, paging, counts and delayed socket access.

The [invitation email API](../../docs/api/members.md#invitation-email) accepts an
Admin's email input after checking the signed-in session, Origin, organisation,
current membership events and OpenFGA. Its response makes no claim about the
invited person's account. Acceptance checks are described in the API contract.
`src/members/admission.ts` selects a member id from the silo, issuer, subject and
admission number. The member-history limit is 10,000 events. `test/groups.test.ts`
covers existing ids, removed admissions, conflicting identities, duplicate bindings
and both limits.

## Model access reads

`GET /api/org/models/:modelId/access` and
`GET /api/org/models/:modelId/access/candidates` require a verified same-silo
Owner or Admin. Session role claims do not grant access. Both replies use
`cache-control: no-store`; denied reads contain no model or candidate data.

The access response uses the `modelAccessResponseSchema` from
`@opencrane/protocol`. It includes the model-grant stream position, current grant
facts, direct/group/assistant source labels and registry support. It returns at
most 100 grant rows and an exact `grantTotal`; the explanation section does not
repeat those rows. A personal assistant uses its owner's display name followed by
`personal assistant`. It reports
provider binding, enabled-model, key and verification facts as not available yet.
Configured assistant uses also remain not available yet until binding records
exist. It does not read provider secrets or conversation history.

Candidates require `kind=member|team|assistant`, accept `limit` from 1 to 100 and
use the last returned id as the optional `after` cursor. Member choices include
active members only. Group counts use current joined membership rows. Assistant
choices use assistant creation events and contain no private conversation data.
The response reports the oldest checkpoint among the member, group and model
access tables. A lagging table is marked applying instead of being presented as
current. Reads check authority once before loading their result; they do not keep
a change watcher open while the result is assembled.

## Bound invitation checks

`POST /members/join` uses the [member API contract](../../docs/api/members.md#bound-invitation-acceptance).
It requires the exact organisation, verified ASCII session email, a sign-in within
60 minutes and current inviter role for a fresh join. Saved-command receipts stay
readable while the admission has not been removed. Removed admissions return
403 `access_removed`. Unavailable replies may follow a stored append.
The join store supplies `readStream`, `head` and `append` so the shared
`authorityFence` can check member and ownership events before the write.

The API contract's [Zitadel deployment requirements](../../docs/api/members.md#zitadel-deployment-requirements)
are required for acceptance: self-registration off; no external identity providers
that assert verified emails; only trusted admins may mark an email verified; and
`idTokenUserinfoAssertion=true` on the app. Emails are not unique in Zitadel.
The contract records the accepted window between the last inviter check and the
append, which is conditional only on the joining member stream.

The sign-in callback limits the complete session cookie header to 3,800 bytes.
Larger sessions return a clear 400 error and clear both cookies. Browser requests
receive plain text for this error. Invalid session data, including an email longer
than 320 characters, also fails sign-in before a session cookie is written.

## Approval signals from computers

The bridge advertises `approvalWaiting: true` in `resume`. Older computers ignore
this extra field. A new computer can treat its absence as no approval-signal
support, so it never sends an unknown message to an older server.
The bridge accepts a strict `approval_waiting` message before parsing stored reports.
It has a lower-case 64-hex `approvalId`, plus `conversationId` and `turnId` of
1–200 characters. A socket keeps at most 64 waiting approvals. Repeated messages
reuse the existing entry. A valid new signal beyond the limit receives
`outcome_unknown` at once, so the computer can fail its call. Invalid messages
and mismatched saved bindings are ignored. An empty request stream removes the
entry and returns `outcome_unknown`; it cannot become a valid request by retrying.
The saved request must name the link's assistant, the supplied approval id,
conversation and turn before `readApproval` can expire or cancel it.

The bridge polls each waiting entry independently, with a ten-second read limit.
It checks entry positions only after the overall event position changes, when
an expiry is due, or when a failed read is ready to retry. A newly received entry
gets its first check even if no event has arrived. It reads the approval again
when its approval, conversation or tool policy stream moves, and when the saved
expiry time arrives. Each failed entry retries after one second, then doubles
its delay up to 30 seconds. A successful check clears that delay. An
`approval_settled` message returns `approved`, `denied`, `expired`, `cancelled` or
`outcome_unknown`, then removes the entry. Socket messages are never stored and
never grant permission to send a tool call. The decision service checks each call.
A reconnect starts with an empty map; the computer must announce its waits again.

The server and computer can be deployed in either order. The computer advertises
`x-opencrane-approval-waiting: true` in its WebSocket upgrade response. This server
checks it on every new connection before offering Ask tools with a review. An
older computer receives Allow tools only. A new computer sends `approval_waiting`
only after this server advertises its own support in `resume`. An older server
without that marker receives no approval signals.

Tests: `test/bridge-approvals.test.ts` uses real NATS and a real socket for the
message route. It covers request bindings, saved states, reconnects, duplicate
messages, changed conversations and policies, expiry, failed reads, back-off,
empty requests, visible capacity refusal and quiet polling.
`test/bridge-replay.test.ts` also sends signals through `watchBridges`. A decision
reaches only the waiting computer. A blocked approval read leaves another
conversation's reports and next turn free to continue.

Local guard checks on 8 October 2026: PASS. The inert handler failed all 17
initial tests before implementation. Sixteen separate mutations then failed
their owning tests: the four saved request bindings, approval-id format, duplicate
registration, duplicate reads, capacity, closed sockets, changed conversation and
approval positions, quiet-read caching, expiry, saved state, strict message fields
and the socket message route. Each mutation was restored before final checks.

Review fixes on 9 October 2026: the focused approval tests failed in six cases
before the implementation changed. The tests were committed first. Removing the
approval poll from `watchBridges` made its new socket test time out; the poll was
restored. [Check record](../../docs/process/approval-watcher-review-fixes.md).

## Model grant changes

`POST /api/org/models/:modelId/access` accepts only `{commandId, expectedSequence,
action: "grant" | "revoke", granteeKind, granteeId}` in at most 2 KiB. It requires
an organisation session, exact Origin and current Owner/Admin events plus OpenFGA.
Targets for grants must exist in this silo; people must be active members. Revokes
can remove a departed person's grant. Grants require an active registry model;
retired models stay revocable and unknown model ids are refused. A grant changes
neither provider selection nor paying-group membership. The browser editor stays unavailable.

POST and status GET check current Owner/Admin access before reading grant history.
History has a ten-second limit before the two-second check on caller and ownership.
Person and assistant targets are checked for changes separately. Team grants read
only the creation event before the check and do not watch membership activity.
An empty team revoke reads assistant selections before that check, with a ten-second
limit, to find a selected starting grant that has not been saved yet.
One conditional append uses `historyChecked` and the original access deadline.
A saved `appended` receipt names the original command, event and position.
Identical repeats return it; changed payloads or stale positions give 409 `refused`
without a new event. Empty revokes return `no_effect`, except an unseeded starting
grant revoke, which is saved so the worker cannot restore it. The full rules and
409 target reasons are in the [model grant API](../../docs/api/providers.md#changing-model-grants).
Invalid or unauthorised requests give 400/401/403 `refused`.
503 `unavailable` means checks failed before append; 503 `unknown` means append
or its reply is uncertain. Recovery uses only
`GET /api/org/models/:modelId/access/changes/:commandId`, with current authority.
It returns the original receipt, currentSequence and separate content/IAM
`current` or `applying` states. 404 `unknown` does not prove absence while a POST
may still be running. Every reply uses `cache-control: no-store`.

## Invitation review fixes

New email invitations use caller-generated UUID v4 member ids. Renewals locate
candidates by email in the members projection and check each candidate's events.
The lookup stops at 100 candidates; each stream read stops at 10,000 events.
The route never scans `member-*`. The members projection is required for POST.
Stored data failures return 503, while invalid request bodies return 400.
A changed watched stream returns the caller's saved command result, an access
refusal if their admin access ended, or 409 `concurrent_change`.
The optional invitation clock sets session checks, event time and seven-day expiry.
Tests cover its exact expiry boundary and acceptance of a route-created invitation.
Acceptance refuses active identities itself, including joins after
the candidate read and delayed member projections.

Email-only acceptance requires the members projection through `DATABASE_URL`.
It reads up to 100 candidate ids by issuer and subject with their checkpoint in
one query. It includes member events after that checkpoint and verifies each
candidate from its own stream. It refuses incomplete reads, more than 10,000
unapplied events or more than 10,000 events in one candidate stream. Its event reads
have a ten-second deadline and finish before the two-second access check.
Older unrelated member history does not count towards these limits.
It keeps the invitation’s member id and records issuer and subject on `member.joined`.
After the account read, acceptance checks that the invitation stream still has
the position read at the start. This check finishes before the two-second access
check. A renewal returns 409 `unknown_invitation`; another unexplained change
returns 409 `concurrent_change`. No join uses the old role or assistant choice.
The final check confirms the member position has not moved, and the conditional
append uses that position across `member-*`. Concurrent accepts on different
invitations cannot admit the same account twice. Other member changes also require
a retry with the same command. The projection can rebuild the account binding.
Bound acceptance needs no database and retains its own member-stream append.
See the [email acceptance contract](../../docs/api/members.md#email-only-invitation-acceptance).
`test/invitations.test.ts` covers renewal before and after the account position
is read, during the access check and just before append. Each case checks the
saved events and the renewed role in PostgreSQL.
`test/email-admission.test.ts` checks invalid checkpoints, candidate and history
limits, conflicting account bindings, bounded reads and events after the saved
member position. `test/member-joined.test.ts` also checks saved invitation ids,
missing databases, expired append deadlines and rejected join identity projection.

## Waiting tool calls

Turn lists now include reviewed, zero-cost Ask tools only when discovery carries a review.
Allow tools still fail if policy changes to Ask mid-turn.

Human group events are now valid stored records. Chat reads, lists and
subscriptions check saved participation and the caller’s latest join position.
Creation and participant commands for that mode are not exposed yet.

Provider binding POSTs use the existing organisation, exact Origin and current Owner/Admin checks with a 4,096-byte limit. GET reads checked event histories, reports real default counts and marks routine history as absent or unsupported. Reader failure or changing history returns 503. See [the provider API](../../docs/api/providers.md).

Concurrent binding and configuration requests with the same command id return
one saved receipt and one 409 response. Both must finish their final access checks
before the test lets either append. `changes/:commandId` returns the saved operation
and its original event id. Configuration replies also read the saved event before
reporting success, so a binding cannot be mistaken for a saved model change.

## Conversation participation reads

Chat, approvals, files and desktop checks share the current audience and latest join
position from NATS. Removal refuses access before OpenFGA applies it; joins need their
applied receipt. Sockets watch member and participation streams, plus the actual team
for private team sessions. They keep polling during blocked content reads and drain
full pages before ready. History, titles and saved change status start at the latest join.
Legacy event positions come from `conversation_legacy_participation`, which contains
only old conversation-stream changes. The reader checks each saved record against NATS
once and retains the latest join or removal per person. Later reads fetch only newer
legacy references; modern participation never enters that query. Stop readers before
replay so retained facts cannot outlive replacement tables.
File reads and desktop checks read the projected close together with the conversation
worker's position. They confirm a projected close against NATS, or read every later
conversation record when no close is projected. A buffered report cannot hide a close.
If that backlog cannot be checked before the read deadline, access is unavailable.
The closure summary retains only a closed flag and the last checked position for up to
256 conversations. Checks resume after that position or the worker's newer position,
so a delayed worker does not make every lease reread the same chat activity. The shared
summary reader gives catch-up its own ten-second deadline; a caller still refuses access
when its original deadline expires. Restart readers after event-store restoration and
stop them before replacing the conversation tables, as with retained participation facts.
Approval decisions read history and the encrypted review before the two-second write
check. They carry the checked approval sequence and conversation position forward,
then check only later conversation changes and the current tool policy before append.
The approval append also uses the remaining write deadline. File commands load their history before checking participation.
The offline upgrade must finish with old workers stopped before readers restart.
Participant controls use separate commands. Real-service regression tests cover
removal, blocked delivery, re-joins, other access readers and 100,000 messages.
Conversation lists reuse checked member facts within the request and pass the checked
creation event to private-session checks. Each permission reply is followed by member and
participation position reads. A changed position reloads those facts before returning
content, so an old OpenFGA answer cannot hide a newly saved removal.
Fresh-install browser qualification remains NOT RUN.

Personal agent sessions retain screenshot capture for current participants who have a
desktop grant. A late participant can list and download screenshots saved after their
latest join. Older previews and downloads are refused, including after projection replay.
Private team sessions still refuse participant capture.

## Governed memory recall

`POST /mcp/memory/server` serves stateless 2026-07-28 discovery, listing and scoped recall.
Only recall is advertised. Remember and other memory operations remain separate work.
Recall selects the requester's person scope, the bound assistant's notes, or its
owner group's scope. Another assistant or membership cannot add a scope. Notes
and group reads require the live assistant audience, current group membership
where applicable, and recorded requester/assistant operation grants. A grant to
the assistant's owner group can supply requester read rights after membership checks.
Discovery requires MCP access without requiring a personal memory read grant.
Private remember calls are refused even with plausible shared source references.
Shared-only execution remains unavailable, and native turns receive no memory tools.

The models process needs `TOKEN_SIGNING_KEY_FILE`. `MODEL_MCP_ROUTES` must include
`{ "serverId": "memory", "connectionId": "server", "upstream": "<server-host>:<port>" }`.
The server uses its existing token issuer's public keys and `MEMORY_KEY_DIRECTORY` settings.
Deployment keeps the backend behind the gateway; unsigned direct requests are refused.

The [memory capability contract](../../libs/models/README.robot.md) explains signature,
scope, policy and current grant checks. Replies fit within 16 KiB.
`test/memory-mcp.test.ts` uses real agentgateway, NATS, PostgreSQL and OpenFGA.
The successful fixture records a `restricted` execution mode. A legacy start without
a mode is refused, as is `memory_free`. Both the requester and assistant need
recorded grants of the right identity kind and current OpenFGA permission.
The fixture warms service clients. Fresh-install journeys and backend network
isolation remain NOT RUN. A valid signed context may be replayed during its short lifetime.

## Repeating a provider-bound turn

Turn start/close records can retain `providerId`, `bindingSequence` and `model`.
`turnCommand` keeps the first start's choice on repeat and closure. The bridge
uses that saved model when issuing another pass. Legacy records keep task-table
selection. Admission does not yet select a saved assistant or default binding.

`test/bridge-replay.test.ts` checks a bound turn through real NATS, a WebSocket
connection and the signer. The start acknowledgement contains a signed pass with
the saved provider, binding position and model. Reconnecting and repeating the
report after another binding is saved returns the same choice. The test verifies
the signature and claims; it makes no paid call.

## Human group creation and sends

Members can review their own groups and create a chat with a fixed audience,
even without a personal assistant. The [group API](../../docs/api/group-chats.md)
owns the request shapes, limits, retry rules and refusal responses. Group sends
use the existing message route. Commands load an incremental history summary
before the two-second access check and point-read saved replies.
`test/direct-chat-http.test.ts` uses real NATS, PostgreSQL and OpenFGA for group
picker access, changed snapshots, lost replies and zero assistant activity.
It checks the same generic refusal for unknown, foreign and removed participant ids.
Separate cases check changed audiences, changed positions, departed members without
a group association, and group changes before and during the write check. Each
refusal leaves the conversation stream empty.
Participant controls use separate commands. Fresh-install qualification remains NOT RUN.

## Delivering the admitted model to computers

Start acknowledgements include `model` alongside the signed turn pass. Both use
one choice from the saved start, or the task table for legacy starts. Repeating a
start after a binding moves or pauses keeps its original model and provider claims.

`test/bridge-replay.test.ts` checks the server and computer bridge together through
real NATS and WebSocket connections. Both memory-free and restricted runners pass
`gpt-6-luna` to the Codex `turn/start` boundary when the saved start selects it.
Renewal after a recorded pause keeps that choice and does not start Codex again.
The test verifies signed claims. It uses a recording Codex driver, not a live Codex
process or paid provider.

This is the computer-delivery slice of P4-22 row 4. New-turn selection from own or
default bindings, migration commands and the recorded switch-on event remain for
a later change. Managed calls and retirement stay unavailable. Existing deployments
keep the deployment-key path; bound tokens still refuse before reserving money.

## Human group participant commands

The [group participant API](../../docs/api/direct-chats.md#group-participants) defines
reads, creator edits, self-leave, stale positions, limits and saved retries. Commands
load access, close and command histories before their two-second write check, then
conditionally append once to `participation-<id>`. Saved command positions use
`readStreamSummary`; retry payloads are checked with `readEvent`. Group creation,
participant controls and group sends use separate routes.
`test/chat-access-regression.test.ts` covers the commands with real NATS, PostgreSQL
and OpenFGA, alongside socket, history, file, desktop and approval refusals.
The test for the last participant slot holds two additions after their final access
checks, immediately before the real append. It checks one saved event, one HTTP 409,
exactly 97 current participants and no event from a later stale edit.
The removed-author test keeps OpenFGA permission unchanged after removal. It checks
that the request returns 403 and saves no message. A successful group send followed
by removal is NOT RUN until the group send routes are integrated.

The [participant command receipt](../../docs/process/p4-5-pr4-evidence.md) records checks
and the remaining live qualification.

## Changing member roles

Owners and admins can change member and admin roles. Each change checks current
access and records an appointment receipt. An owner stays an owner when another
person's role changes. An owner can step down only while another active owner remains.
See the [role contract](../../docs/api/members.md#change-a-member-or-admin-role).
Role status requires the competing appointment's IAM receipt in either saved order.
The content checkpoint must also cover both changes. A role receipt alone cannot report
IAM as current while that appointment is still waiting to be applied.

## Recorded tool failures and approval actions

The [approval API](../../docs/api/approvals.md) explains tool failure records and approval actions.

The [member API](../../docs/api/members.md#invitation-command-status-and-refusal-history)
records saved invitation results and safe refusal history.

Invitation status routes require the original human caller. The legacy route keeps
its receipt shape and returns 404 for another admin's command. Audit routes set
`Cache-Control: no-store` before handling success, refusal and errors.

`test/invitations.test.ts` covers permission denial and outages, unapplied access
changes, removal during an audit read, reads without writes, refusal recovery
limits, daily join refusal limits and safe HTTP history after replay.
`test/member-refusals.test.ts` checks refusal fields, invalid history, the
10,000-record limit and real NATS read deadlines. Set `PG_TEST_URL` to a
PostgreSQL service that allows disposable databases for the route tests.

Refusal status reads compare a SHA-256 digest of the requested command id with
`originalCommandDigest`. Refusal events never store the raw id. Invitation events
and status replies retain their existing command ids. The event security checks
reject raw command-reference fields without adding a field-name exception.

Audit routes call `isOrganisationSession` with `extraIdentities: []`. Both history
routes require the configured organisation even when development sign-in allows
a named outsider. The source guard continues to cover `audit/routes.ts`.

Ownership refusal tests allow exactly one `member.command_refused` audit event.
They still require unchanged member and ownership stream positions, unchanged
effective roles and an unchanged membership outcome after projection. The pending
Owner-role invitation remains invited; the active owner remains an owner.

## Member access and departure reads

The Owner/Admin GETs `/api/members/:memberId/access` and `/api/members/:memberId/departure`
check events and OpenFGA once. They stop after ten seconds or 10,000 inventory records.
Checked event positions, computer rows and history totals form the review revision.
Behind tables and unsupported ownership, routines or connections block completion.
The latest grant changes include revocations for each member, group or assistant.
The latest group removals are kept even when no access rows remain. Both reads
stay incomplete until OpenFGA receipts confirm these changes were applied.
Shared-assistant selection checks the group membership and its receipt independently
of resource grants, as well as the assistant creation receipt. A missing membership
receipt reports unavailable selection rather than denied access.
Failed reads return 503. Only counts and dates leave conversation tables.
Tool, publication and connection readiness stay unavailable. Removal stays disabled.
`test/member-inventory.test.ts` uses real services. Fresh-install qualification: NOT RUN.

## Governed personal remember (P4-12 PR 3c)

`remember` uses the human command path with an agent principal bound to the requester.
Its command id is separate from human command ids. Retries return the original receipt;
changed input conflicts. Recovery checks the recorded principal kind, including after a
saved append loses its reply. The event links the conversation, turn and decision request.

A recall page includes `recallProof`, a signed list of returned fact ids and revisions.
It binds the silo, requester, assistant, computer generation, conversation, turn, thread,
content class and selected scope. It contains no fact text and needs no saved permit table.
Proof bytes count towards the 16 KiB reply limit. Page-limit placeholders are excluded.
Remember requires this proof, non-empty same-scope `dependsOn`, and empty `sources`.
The command also checks that dependency revisions still exist, decrypt and have not expired.
An agent cannot claim a human statement. This proof checks references, not whether the
model's wording follows logically from them.

The final append rechecks the original capability deadline, live turn and watched grants.
Every agent write to group or assistant-notes scope returns `agent_person_scope_only`,
even with valid shared recall references and write grants. The command also refuses
another person's scope. Claimed `shared_only` contexts remain refused. Server-recorded
shared-only execution, its input isolation and shared agent writes are deferred to a later PR
after #94. Native turns still
receive no memory tools. Fresh-install qualification and backend network isolation are NOT RUN.

Source checks on 10 October 2026: PASS for lint (including Knip), typecheck,
check:events (99 types) and lint:changelog. The five-file targeted set passed
222 tests twice with `PG_TEST_URL` set. It covers memory MCP, capability claims,
human memory, memory-worker replay and native tool refusal. All commands used
`nice -n 10`. `npm ci` and shared NATS/Lychee links were installed first.
The test commit precedes implementation. No full root suite, independent review,
fresh-install journey or native memory qualification was run.
