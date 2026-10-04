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

## Original evidence before rebase

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

## Rebase qualification — 4 October 2026

Rebased source: `b493547c812b116f6fd32466669ef07cb861498d` on
`origin/main` at `7b8b1d370836aa21402f42eb5f085779a7cb5195` (uploads #79).
Git reported a completed rebase; the main revision is an ancestor and neither
rebase state directory remains. The working branch is `work/authority-reads`.

The exact-subject design replaces the uploads partial fix. It retains parallel
context reads, request-sized budget reservations, approval binding and audit
correlation. Harmless command, file, reasoning and message reports can advance
the exact conversation head; every watched subject is checked again afterwards.
The race test now injects revocation during that exact report read.

Environment: existing Linux workspace, Node 22.23.3, dependencies refreshed with
`npm ci`. No fresh silo, service daemon or host-network change was made. Logs are
in `/tmp/authority-rebase-evidence/` on the builder host.

Independent review of `origin/main..b493547`: **PASS**, no source blockers.
In-memory fence probes passed for unrelated changes, successive output reports,
revocation during a report read, late-discovered teams, wildcard refusal and
expiry after two seconds. These probes did not start service processes.

The retained in-memory probe is executable with
`node /tmp/authority-rebase-evidence/fence-probe.mjs`.

| Rebased gate | Result |
| --- | --- |
| `npm run lint` | PASS, eight function-length warnings |
| `npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS, 85 event types agree |
| `npm run build -w apps/web` | PASS, CSS budget and noVNC CommonJS warnings |
| `npm run test -w apps/web -- --watch=false --runner-config=/tmp/authority-rebase-web-vitest.mjs` | PASS, 11 files / 60 tests; runner config sets `test.maxWorkers` to 2 |

At this checkpoint, the full root suite and 100,000-event benchmark were **NOT RUN**
on the rebased source pending clarification of the instruction never to start daemons. Their
fixtures start temporary NATS, OpenFGA and gateway processes; the full suite also
starts MinIO and ClamAV Docker containers with published localhost ports.
The original latency table above is historical, not a new measurement.
Source qualification at that checkpoint was **PARTIAL**; live qualification was **NOT RUN**.

## Fixture qualification after clarification — 4 October 2026

Source: `e375d0d40565b1a50ab8d67d0a6166b4d73fa89c` plus the fixes recorded with
this receipt. Environment: existing Linux workspace, Node 22.23.3, Docker 29.8.2,
the supplied PostgreSQL test instance on port 55432, disposable NATS, OpenFGA and
gateway fixtures, and upload containers through the host's existing Docker.
This is source qualification, not a fresh installed silo. No additional Docker
or containerd daemon was started and no host network or daemon settings changed.
Other jobs shared the host; observed load averages ranged from roughly 8 to 33.
Full logs are in `/tmp/authority-reads-qualification/` on the builder host.

The first full two-worker run was **FAIL**: 1,376 tests passed, four failed and
14 were skipped, across 81 files in 1,552.95 seconds. It exposed:

- A missing `ocn-upload-computer:test` fixture image. The documented
  `sh scripts/build-test-computer.sh` built it through the existing Docker client.
  The upload file then passed all seven tests, including its real computer,
  MinIO and ClamAV journey.
- A gateway startup race: readiness could return before the request listener
  opened. The new regression failed before the fix and passed afterwards.
  Startup now checks the TCP listener as well; this creates no HTTP audit record.
- A 5,000-event test spending its timeout on command retry lookups during setup.
  It now reuses the existing conditional fixture seeder and checks the exact
  event count before admission. The original admission assertions remain.
- A desktop test adding 1,050 ms of synthetic delay to real service work against
  a 1,200 ms deadline. Controlled-clock tests now verify admission at 1,050 ms and
  refusal at 1,250 ms. The real-service stream test retains delayed reads with
  more scheduling margin. Production deadlines and revocation bounds are unchanged.

The next suite attempt reached the chat Chromium journey's 180-second outer
process timeout. Its production-CSP and folding-motion tests passed. That run was
stopped and restarted after allowing five minutes for Angular startup plus all
chat frames at both widths; browser assertions and per-step timeouts are unchanged.
That journey then passed in 191.47 seconds. A subsequent policy test failure under
the five-second default did not recur in its focused rerun. The final suite uses
the historical 15-second default test budget with two workers; explicitly set
integration deadlines and all decision/revocation limits remain unchanged.

The focused startup, gateway and desktop checks passed. Independent adversarial
review of the fixes: **PASS**, no blockers. The standalone volume benchmark was
**PASS**, including 30 successful decisions per route in each fixture, identical
authority read counts, no wildcard or unrelated reads, and all latency bounds.

| Decision | No seed p50 / p95 (ms) | 100,000 seed p50 / p95 (ms) | Authority streams / events per sample |
| --- | --- | --- | --- |
| Model admission | 476.4 / 701.7 | 431.0 / 671.3 | 8 / 15, unchanged |
| MCP tools/call | 370.5 / 717.4 | 375.7 / 584.7 | 10 / 23, unchanged |
| Destination authority | 136.0 / 268.2 | 104.0 / 214.1 | 4 / 6, unchanged |

Destination timing covers the shared authority check, not a routed egress request.
The standalone run took 147.01 seconds and overlapped the focused upload rerun
on the shared host. These are local measurements, not deployment promises.

The final two-worker suite also passed the volume benchmark, with the same read
counts and 30 successful samples per route before and after seeding:

| Decision | No seed p50 / p95 (ms) | 100,000 seed p50 / p95 (ms) |
| --- | --- | --- |
| Model admission | 195.3 / 235.3 | 199.0 / 417.0 |
| MCP tools/call | 163.3 / 211.9 | 120.0 / 170.8 |
| Destination authority | 58.5 / 85.1 | 50.9 / 83.5 |

The same suite measured **460.1 ms** from the membership-removal append through
NATS, pg-boss and OpenFGA to denial, below the two-second bound.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npm test -- --maxWorkers=2 --testTimeout=15000 --reporter=default
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  npx vitest run libs/models/test/authority-volume.test.ts \
  --maxWorkers=2 --disableConsoleIntercept
```

| Final gate | Result |
| --- | --- |
| `npm run lint` | PASS, eight existing function-length warnings |
| `npm run typecheck` | PASS across all workspaces |
| `npm run check:events` | PASS, 85 event types agree |
| Full root suite above | PASS, 79 files / 1,383 tests; 3 files / 14 tests skipped; 993.95 seconds |
| Standalone 100,000-event benchmark above | PASS, 147.01 seconds |
| Independent review, two passes | PASS, no blockers |

The full-suite receipt is `root-suite-complete.log`; a temporary additional
reporter printed failure details immediately without changing execution. The
standalone receipt is `benchmark.log`. The earlier failed run and interrupted
attempts are retained as `root-suite.log`, `root-suite-final.log` and
`root-suite-qualified.log`. `gateway-start-red.log` retains the startup regression
failure before the fix; focused green logs are in the same directory.

The 14 skips require explicit opt-ins for the deployed k3d lifecycle, bridge and
live-view journeys, the approval browser journey, or real model calls. Those
conditions are **NOT RUN** here. Source qualification is **PASS**; fresh-install
live qualification remains **NOT RUN**. The rebase's earlier Angular workspace
build/unit-test receipt remains historical; this run covers the root suite's
Chromium journeys, not a new standalone Angular workspace qualification.

## Not in this change

P3-20's egress endpoint and refusal suite are absent from this main revision.
Its routed one-second journey and fresh-install qualification are **NOT RUN**.
The destination-authority benchmark does not claim to qualify that endpoint.
Approval card listing still uses its existing replay query; deciding a known
approval uses exact subjects. Very long individual subjects may later need a
fenced, rebuildable projection.
