# NATS TLS and account evidence

Receipt: 2026-10-01, branch `work/nats-auth`, review-fix base `da860a8` plus this change.
Environment: Linux x86-64, Node 22.23.3, OpenSSL 3.0.13, pinned nats-server 2.15.0;
real PostgreSQL 17.11 via the supplied control URL and disposable child databases;
real OpenFGA containers from the existing pinned fixture. Fresh local NATS stores,
test CAs and random NKeys on each fixture; not a fresh deployed silo.

Contract: [ADR 0005](../adr/0005-nats-access.md).
Command logs are retained on the builder host under `/tmp/nats-auth-*.log`.
The final commit includes this receipt; no credentials are in these logs or docs.

## Acceptance proofs

The [security suite](../../libs/event-store/test/security.test.ts) has 27 cases;
the [real-process suite](../../apps/server/test/main.test.ts) adds the startup
refusal and runs the existing HTTP command acceptance over authenticated TLS/NKeys.

- Finding 1: trusted-CA certificates with `CN=unknown` and command-matching DNS,
  email or URI SANs cannot authenticate an unknown NKey or grant command rights to
  any of the four non-command roles. A command CN with a projection seed cannot
  publish events or subscribe to command inboxes. Certificate-only authentication,
  chosen usernames and a command public key signed with the projection seed fail.
- Finding 2: both readers receive events from separately provisioned consumers;
  the dispatcher acknowledges its own delivery. Both roles are refused create,
  update, delete, reset and pause operations against their own, the other role's,
  arbitrary and prefix-lookalike names. Requests exercise all four create API forms,
  changed/multiple filters and push destinations in command inboxes or event subjects.
  Consumer configuration, delivery position and acknowledgement floor stay unchanged;
  arbitrary consumers remain absent. Cross-role pulls, info, acknowledgements and
  inbox subscriptions are refused.
- Forged reply destinations on otherwise permitted message-get and pull APIs cannot
  deliver into EVENT_CORE inboxes or append to EVENTS. Separate accounts contain
  those responses; the source head remains unchanged.
- Both readers are refused event publication and stream create/update/delete/purge/
  restore/snapshot, including another stream. Computer and gateway are refused all
  event subscriptions, publishes, stream access and consumer operations.
- Plaintext CONNECT/PUB/PING is closed before INFO/PONG; wrong server CA and missing
  client certificates fail TLS. Missing/blank/unreadable credentials, malformed NKey
  seeds and credentials embedded in URLs fail closed.
- Existing real-service suites cover HTTP command append, races/restart/idempotency,
  backup/restore, projection rollback/replay/rebuild, dispatcher SQL commit crash
  boundaries and OpenFGA revocation. Projection/dispatcher connections use reader
  roles; explicit command-side fixture steps represent installation/replay provisioning.

## Gates

The final root test runs use `PG_TEST_URL` as an admin/control URL; fixtures create
and drop child databases. No integration tests are skipped.

| Command | Result |
| --- | --- |
| `npm run lint` | PASS: all five checks; 0 errors, one existing websocket length warning; 38 Markdown files, 120 local links OK, 29 external links excluded. |
| `npm run typecheck` | PASS: all 10 workspaces. |
| `npm run check:events` | PASS: 70 types agree. |
| `PG_TEST_URL=… npm test`, final run 1 | PASS: 43 files / 849 tests / 0 skipped; 105.31 s. |
| `PG_TEST_URL=… npm test`, final run 2 | PASS: 43 files / 849 tests / 0 skipped; 92.44 s. |
| `PG_TEST_URL=… npm test`, final run 3 | PASS: 43 files / 849 tests / 0 skipped; 89.54 s. |
| `npm run build -w apps/web` | PASS: Angular production build. |
| `npm run test -w apps/web` | PASS: 2 files / 27 tests. |
| S0.7 focused checks 1, 2, 3, 6, 7 | PASS: 5 files / 7 tests; 55.82 s. |

The S0.7 checks use this worktree's dependencies and verified nats-server 2.15.0
and natscli 0.5.0 Linux binaries. Run from `spikes/s0-7-jetstream` with
`../../node_modules/.bin/vitest run` and the five corresponding test paths.
Historical spike consumers use command/operator NKeys because they create temporary
consumers; their checks establish compatibility, not reader isolation. Current reader
isolation is proved by the root real-service suites above. No million-subject benchmark
or R3 failover run is implied.

Development found the OpenFGA fixture also needed explicit dispatcher provisioning.
The no-JetStream fixture now removes service routes so dormant imports do not count
as responders in its no-responder test. Earlier failed development runs are not
counted as gate passes. Lint also prompted a small extraction of the consumer
configuration check and explicit tuple types for fixture public keys; all three root
runs were repeated afterwards. No runtime dependency or licence change was introduced.

## Remaining qualification

No additional review passes were run, as requested. Hosted CI, fresh Helm installation,
production seed/certificate issuance, rotation and revocation, TLS on R3 routes,
deployed R3 failover and runtime image inventory remain **NOT RUN**. NKeys do not
expire by themselves; the installation must rotate server public keys and client
seed leases as described in ADR 0005. No push or deployment.

Integration with `work/replay` remains **NOT RUN**; the reported textual conflict
requires preserving both reader credentials and replay verification when that branch
is integrated. This fix does not merge the other feature branch.
