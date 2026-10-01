# Member invitation acceptance evidence

Receipt: 1 October 2026, branch `work/member-joined`, base `48f281a` plus the
change containing this receipt. Local Linux, Node 22.23.3, clean `npm ci`, pinned
NATS 2.15.0 on disposable directories and PostgreSQL 17 in `pg-test`. This was
not a fresh silo installation. No independent review ran in this builder task.

The acceptance journey uses the real encrypted session codec, Fastify route,
event-store adapter, NATS ordered consumer and members projection in PostgreSQL.
The command has no database handle. Its successful response precedes the
projection update; the listener advances the row and checkpoint afterwards.

| Gate | Observed result |
| --- | --- |
| `npm ci` | PASS; 837 packages installed, audit found 0 vulnerabilities |
| `npm run lint` | PASS; all 5 stages, 116 modules / 259 dependencies, 0 violations |
| `npm run typecheck` | PASS; all 8 workspaces |
| `npm run check:events` | PASS; 70 event types agree |
| `npm test` with `PG_TEST_URL` | PASS; 37 files, 768 tests, no skipped tests |
| `npm run build -w apps/web` | PASS |
| `npm run test -w apps/web` | PASS; 2 files, 27 tests |

The [30 command tests](../../apps/server/test/member-joined.test.ts) prove:

- Acceptance makes one conditional append, takes role/email from the invitation,
  reaches PostgreSQL through the real projection runner, survives a connection
  restart and produces identical rows after dropping and rebuilding the projection.
- A retry after NATS restart and invitation expiry returns the stored sequence
  without another append. Reusing the key with changed arguments is refused.
- Two accepts forced to read the same sequence produce one durable winner;
  concurrent identical commands return one joined and one already-joined result.
- Wrong identity/issuer, other session organisation/event silo, unknown/expired/
  unbound invitations, inconsistent history, invalid input/origin, and missing,
  tampered or expired sessions cannot append. Missing configuration fails closed.
- A different identity/issuer cannot claim another principal's successful retry.
  Removal cannot be undone by a new accept; retrying the old command only reports
  its historical success.
- Real NATS outages during reads and immediately before append return sanitised
  unavailable results; the durable log remains unchanged. The connection adapter
  reaches the same real store.

The added [process test](../../apps/server/test/main.test.ts) launches `main.ts`
under Node type stripping, calls the configured route over HTTP and verifies its
durable append in real NATS. Existing auth, event-store and projection tests also
passed in the root gate.

NOT RUN: orchestrator-owned independent review, checks after integration on main,
fresh-silo deployment/sign-in acceptance, R3/TLS/account qualification, OpenFGA
and dispatcher reactions. This receipt claims local source evidence only.

Policy gap: `plan.md` does not define first-member bootstrap. Only invitation
acceptance is implemented. Invitation creation and binding an invite to the
provider's issuer/subject are separate work; old invitations without that binding
and an explicit expiry remain replayable but cannot be accepted.
