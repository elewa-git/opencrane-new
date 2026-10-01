# NATS TLS and account evidence

Receipt: 2026-10-01, branch `work/nats-auth`, base `cf3bfc2` plus this change.
Environment: Linux x86-64, Node 22.23.3, OpenSSL 3.0.13, pinned nats-server 2.15.0;
real PostgreSQL 17.11 via the supplied control URL and disposable child databases;
real OpenFGA containers from the existing pinned fixture. Fresh local NATS stores
and test CAs on each fixture; not a fresh deployed silo.

Contract: [ADR 0005](../adr/0005-nats-access.md).
Command logs are retained on the builder host under `/tmp/nats-auth-*.log`.
The final commit includes this receipt; no credentials are in these logs or docs.

## Acceptance proofs

The [security suite](../../libs/event-store/test/security.test.ts) has 15 cases;
the [real-process suite](../../apps/server/test/main.test.ts) adds the startup
refusal and runs the existing HTTP command acceptance over authenticated TLS.

- Real Node server: authenticated `POST /members/join` appends to EVENTS with the
  command certificate; startup with enabled NATS but missing TLS paths fails.
- Both reader roles: consume a stored event; NATS refuses event publish and stream
  create/update/delete/purge/restore/snapshot, including another stream. History
  and stream configuration remain unchanged after the attempts.
- Computer and gateway: NATS refuses direct/wildcard event subscriptions,
  publishes, stream reads/writes, consumer creation/pulls and acknowledgements.
- Unknown identity: a valid certificate from the trusted CA still fails NATS
  authentication. A client without a certificate cannot connect either.
- Transport: raw plaintext CONNECT/PUB/PING is closed before INFO/PONG; wrong
  server CA fails certificate verification. Missing config/files and credentials
  embedded in a URL fail closed.
- Existing real-service suites run under TLS: append races/restart/idempotency,
  native backup/restore, projection replay/rebuild, dispatcher SQL commit crash
  boundaries and OpenFGA revocation. Projection/dispatcher fixtures use read roles.

## Gates

The three final root test runs use `PG_TEST_URL` as an admin/control URL; fixtures
create/drop child databases. No integration tests are skipped.

| Command | Result |
| --- | --- |
| `npm run lint` | PASS: all five checks; one existing websocket function-length warning, no errors; 38 Markdown files; 120 local links OK, 28 external links excluded. |
| `npm run typecheck` | PASS: all 10 workspaces. |
| `npm run check:events` | PASS: 70 types agree. |
| `PG_TEST_URL=… npm test`, final runs 1–3 | PASS on each run: 43 files / 837 tests / 0 skipped; 88.70 s, 79.91 s, 79.48 s. |
| `npm run build -w apps/web` | PASS: Angular production build. |
| `npm run test -w apps/web` | PASS: 2 files / 27 tests. |
| S0.7 focused checks 1, 2, 3, 6, 7 | PASS: 5 files / 7 tests, 52.43 seconds. |

The S0.7 checks use this worktree's installed dependencies and the verified
nats-server 2.15.0 and natscli 0.5.0 Linux binaries. Run from
`spikes/s0-7-jetstream` with `../../node_modules/.bin/vitest run` and the five
corresponding test paths. This checks its changed helpers and CLI TLS flags;
it does not rerun its million-subject benchmark or R3 failover.

Development caught and corrected empty NATS allow lists (they do not deny access)
and the SDK's alternate consumer-create endpoint. The initial simultaneous lint
and test run hit an ESLint directory-deletion race; running lint after the fixtures
finished passed. Earlier failed development runs are not counted as gate passes.
No runtime dependency or licence change was introduced.

## Remaining qualification

NOT RUN: independent review (excluded by task), hosted CI, fresh Helm installation,
production secret-store certificate issuance/renewal/revocation, TLS on R3 cluster
routes and deployed R3 failover, runtime image inventory. No push or deployment.
The historical S0.7 clients now also require certificate paths and use the shared
permission configuration; its million-subject benchmark and R3 cluster journey
are separate qualification, not implied by root tests.
