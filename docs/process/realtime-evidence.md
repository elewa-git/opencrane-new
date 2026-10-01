# Members realtime and server shutdown

Branch `work/realtime`, based on `2bf0c05`. Local source evidence on 1 October
2026, Node 22.23.3, PostgreSQL 17.11, pinned NATS 2.15.0 and OpenFGA 1.21.0.
No independent review was run by the builder. This is not a fresh silo deployment.
Review fixes were tested at source commit
`2bd1c6faebec01366cc32fb62b94360a528b4cbf`. The backpressure test correction
was tested at source commit `883d12a20db2fb5d49ce7dbb4eaada14066e9f30`.

## Why

Browser tabs need resumable projection reads with permission checks. Server
termination must release WebSockets and stalled requests without cutting off
valid HTTP requests before their advertised grace period.

## What

The existing `/ws` endpoint now accepts the members topic. A durable, replayable
change table holds complete member states at event-log positions. PostgreSQL
NOTIFY wakes reads after commit. Invitation bindings connect OIDC subjects to
member ids; OpenFGA checks permission without trusting cookie roles. Heartbeats,
input limits and bounded output protect each connection. Slow peers reconnect
from their own last applied position. The existing tab singleton can send the
shared subscribe type; a members page and automatic browser state storage are
separate work.

The first signal stops acceptance, sends WebSocket 1001 and waits for HTTP using
the full grace period. Newly idle keep-alive connections close after their
responses finish. A single cleanup path closes NATS, the feed and telemetry.
Timeout or cleanup failure exits 1; a second signal exits 1 immediately.
Process docs describe the new feature-branch and orchestrator-owned PR workflow.

## Evidence

The [realtime process tests](../../apps/server/test/realtime.test.ts) use real
NATS, separate PostgreSQL databases, real OpenFGA and `main.ts` child processes:

- Three upgrade cases refuse absent cookies and foreign/missing Origins.
- Three identity cases refuse unknown subjects, other organisations and a subject
  pretending to be a member id; cookie roles cannot grant access.
- A joined SQL member with removed OpenFGA permission is refused.
- Replay followed by live joins, then reconnect with a racing commit, gives each
  member position exactly once and in order.
- Uncommitted and rolled-back rows stay off the socket; retry publishes the state.
- Removal closes a subscribed socket; a paused OpenFGA service fails closed.
- The 21st application message in a one-second window closes the connection.
- Pausing the actual TCP consumer fills its receive window, causes deltas to be
  dropped with `resync`/1013, and reconnect recovers all 64 positions exactly once.
- A peer withholding pong is terminated after the heartbeat deadline.
- A clock-injected session that expires between upgrade authentication and the
  connection event closes with 1008, and the server continues serving `/healthz`.
- Raw TCP clients sending unmasked frames on active and newly expired sessions
  are terminated without process failure, and `/healthz` continues returning 200.

### Backpressure test correction

The original fixture sent 100 members with 100 KB display names. Temporary
timing probes at base `1dfc697` measured reconnect replay at 103.4–141.4 ms in
two focused runs and 110.6–121.5 ms in three full-suite runs. The reconnect
used two identity/OpenFGA permission checks (3.8–6.9 ms each), then the 72-row
missing suffix used one batched PostgreSQL read (34.2–48.9 ms) and 44.2–55.2 ms
of sends. There was no per-row permission check, database read, rate limit or
awaited network callback.

The paused connection consistently crossed the real socket limit at position
30 with 100,182 buffered bytes. That left another 7.2 MB burst for the resumed
connection, so suite scheduling could make the reconnect itself exceed the
same slow-consumer limit before `ready`. The test now sends 64 members with
64 KB display names: 4.096 MB still exceeds the measured receive window and
proves `resync`/1013, while reconnect only replays the missing suffix. Three
focused runs and ten consecutive full runs retained the exact no-gap,
no-duplicate position assertion.

The [shutdown process tests](../../apps/server/test/shutdown.test.ts) prove:

- Idle SIGTERM and SIGINT exit 0, with one NATS and one telemetry close call.
- An open WebSocket receives 1001 and the process exits within grace.
- A stalled partial body is force-closed at the deadline, with exit 1.
- A complete request held for 700 ms before its real NATS append returns 200,
  stores sequence 2 and exits 0 with a 1000 ms grace period.
- Failed or hung NATS cleanup exits 1; telemetry failure still closes NATS.
- A second signal exits immediately while cleanup is hung.

Fault injection uses a Node test preload around the real adapter; production has
no test environment switches. Tests assert process exit codes and fail if their
SIGKILL watchdog fires. Timeout assertions allow 250 ms for process scheduling.
Projection tests additionally prove rollback, restart and rebuild equality of
member rows, change history and identity bindings on PostgreSQL and PGlite.
They also hold a stray PostgreSQL connection open during fixture teardown and
prove that the child database is removed.
Seven shared-protocol tests cover versioned messages and cursor/topic validation.

| Gate | Result |
| --- | --- |
| Clean dependency installation | PASS; 870 packages installed, 0 audit vulnerabilities |
| `npm run lint` | PASS; all 5 stages, 140 modules / 351 dependencies, 0 errors; 1 advisory function-length warning |
| `npm run typecheck` | PASS; all 10 workspaces |
| `npm run check:events` | PASS; 70 event types agree |
| `npm test`, 10 consecutive fresh control databases | PASS; 42 files / 821 tests each, no skips or errors; 66.72–70.99 s |
| `npm run build -w apps/web` | PASS |
| `npm run test -w apps/web` | PASS; 2 files / 27 tests |
| Staged secret scan | PASS; clean |

Each final root run created a new control database and dropped it afterwards;
test fixtures created their own child databases. An earlier full run passed all
assertions but failed on database teardown errors, including one review-fix run
with all 817 assertions passing. The database fixtures now force the child database
drop in a `finally`, even when a connection remains open. All ten final runs
include that correction. Focused tests also caught and fixed deadline status and
completed keep-alive connection races before these final runs. No failing gate was waived.

## Not in this PR

NATS core fan-out across replicas, a members UI, automatic browser state storage,
conversation topics, history pruning, online projection rebuilds and automatic
LISTEN reconnection are outside this skeleton. A broken listener fails closed;
restart the server to restore it. Existing projections need an offline rebuild.

NOT RUN: orchestrator-owned independent review, hosted CI, checks after merge,
fresh-silo deployment/sign-in journey, R3/TLS/account isolation and deployment
qualification. No capability-done claim is made for those conditions.
