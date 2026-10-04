# Exact authority reads — issue 70

## Why

Gateway authority read every team, conversation and grant stream before filtering.
Its latency grew with unrelated silo history, and category-wide freshness checks
also refused decisions when unrelated authority changed.

## Functional outcome

Model and MCP admission, approval decisions and the shared destination authority
check read exact authority subjects. Unrelated IAM changes neither add history
reads nor invalidate a running decision. Relevant changes and missing OpenFGA
receipts still refuse access; the two-second freshness budget remains in place.

## Architecture

The event store remains the only truth. One global event-head metadata read fixes
the snapshot; no global event log is read. Each exact subject is fenced against
that same head, including subjects discovered later from assistant ownership,
resource grants or the turn's paying group. Existing conditional appends are
unchanged. No dependencies, projections or permission caches were added.

Authority histories start at position 1 on those exact subjects. Cost can still
grow with an individual relevant subject's history; this change removes growth
with unrelated subjects. The resource grant subject contains all its grantees.
The current OpenFGA model permits team membership via the assistant owner or a
resource grant, so those are the only teams authority discovery follows.

## Evidence

Source base: `3972492d9eb556587bfa443b26e154b33e84f83b` plus this change.
Environment: 4 October 2026, Linux, Node 22.23.3; disposable local NATS and OpenFGA
fixtures (single-replica NATS and an in-memory OpenFGA store), isolated databases
on the supplied PostgreSQL test instance. This is
source qualification, not a fresh installed silo. No stack was changed.

The counting probe failed on the original `team-*`, `conversation-*` and `grant-*`
reads before implementation. It now passes at the model decision and approval
command interfaces. Tests also prove unrelated changes do not refuse admission,
late-discovered team changes invalidate the original snapshot, and missing team
receipts refuse stale OpenFGA permissions.

The volume test seeds 100,000 valid events, evenly split across unrelated member,
team, conversation, grant and assistant subjects. Thirty successful samples per
route run in separate fixtures with equal relevant histories, without and with
seeding. Background replay is stopped in both; every relevant OpenFGA receipt is
applied during setup. The unrelated event templates are schema-checked, then
conditionally published on new subjects. It asserts unchanged authority read counts,
no wildcard or unrelated reads, p95 below half the route's deadline, and every
sample below its deadline (1 second for destinations, 2 seconds for ext_authz).
Model and MCP measurements include HTTP admission, authority, reservation where
applicable, and the durable decision audit. Destination measurements cover the
shared authority check only.

The [volume test](../../libs/models/test/authority-volume.test.ts) passed alone and
in the serial required-suite run. The table records the latter run on the shared
host (load averages during work were roughly 17–27).
These are local measurements, not a deployment latency promise.

| Decision | No seed p50 / p95 (ms) | 100,000 seed p50 / p95 (ms) | Authority streams read / events read per sample |
| --- | --- | --- | --- |
| Model admission | 244 / 337 | 181 / 298 | 8 / 15, unchanged |
| MCP tools/call | 191 / 297 | 158 / 245 | 10 / 23, unchanged |
| Destination authority | 47 / 75 | 56 / 89 | 4 / 6, unchanged |

The counts include repeated reads of the same exact subject. Budget/audit append
retry reads are excluded from authority counts, but included in admission timings.
Thirty of thirty decisions succeeded for each route in each fixture.
The existing NATS → pg-boss → OpenFGA integration test measured 495.5 ms from
membership-removal append to denial, below the two-second revocation bound.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run libs/models/test/authority-volume.test.ts --maxWorkers=1 --disableConsoleIntercept
```

The required-suite run exposed a gateway restart race: waiting for child `exit`
could close the log reader before stdout drained. Shutdown now waits for `close`
then queued writes. Crash/replay tests wait for the asynchronous access records
before killing the writer; a completed HTTP response alone does not mean the
native process has emitted its log. The three restart/correlation refusal tests
pass with their existing correlation and replay assertions intact. Independent
review checked the shutdown fix too.

| Gate | Result |
| --- | --- |
| `npm run lint` | PASS, including dependency, unused-code, documentation and fixture checks |
| `npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS, 79 event types agree |
| `npm test -- --maxWorkers=1 --testTimeout=15000 --reporter=dot` | PASS, 72 files and 1,182 tests; 2 files and 11 tests skipped; 1,472.27 seconds |
| `npm run build -w apps/web` | PASS, existing CSS budget warnings |
| `npm run test -w apps/web -- --runner-config=/tmp/authority-reads-web-vitest.mjs` | PASS, 10 files and 54 tests; temporary runner config sets `test.maxWorkers` to 2 |

The full suite used the supplied `PG_TEST_URL` and one worker, with a 15-second
default test timeout. Existing longer integration deadlines were unchanged.
An earlier two-worker run failed an unseeded timing threshold, the browser
journey's timeout and the asynchronous log/crash race described above. The
final serial run passed all three and every existing gateway, approval and
budget refusal test. No skipped condition is claimed as tested.

Independent adversarial review: **PASS**, no source blockers; four focused tests
passed independently. Source qualification: **PASS**. Live qualification remains
**NOT RUN** as described below.

## Not in this change

P3-20's egress endpoint and refusal suite are absent from this main revision.
Its routed one-second journey and fresh-install qualification are **NOT RUN**.
The destination-authority benchmark does not claim to qualify that endpoint.
Approval card listing still uses its existing replay query; deciding a known
approval uses exact subjects. Very long individual subjects may later need a
fenced, rebuildable projection.
