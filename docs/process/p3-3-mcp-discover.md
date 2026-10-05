# P3-3 remote MCP discovery

Issue #44, parent #41; decisions D09–D10. Source: the commit containing this receipt,
stacked on P3-2. OC1 source commit: `10abd0ef6182f36bec13d8f1358e43b15ead7cd5`.
Run date: 4 October 2026. Environment: Linux, Node 22.23.3, isolated NATS/OpenFGA fixtures and disposable PostgreSQL
databases via `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The source tests below touched no dev stack. No remote provider or paid call is part of these tests. New runtime packages were
checked against their installed licence files: Ajv 8.20.0 and json-schema-traverse
1.0.0 are MIT; fast-uri 3.1.8 is BSD-3-Clause. OC1 and this repository are AGPL-3.0-or-later.

## Contract and scope

The authenticated HTTP registration/status interface and event replay prove stable
registration and recoverable status. A worker-only quarantine route exercises real
HTTPS and a local UDP DNS fixture. The test socket adapter maps the checked public
address onto the loopback TLS fixture, retaining actual certificate/hostname checks;
production has no loopback allowance. DNS rebinding is observed between connections,
and the recorded socket lookup proves the selected address is pinned on each one.

The worker uses bounded read-only reconciliation. It does not publish routes, grant
access, connect accounts or call tools. Protected discovery stays Needs input until
P3-9. Catalogue/package source choices explicitly remain unavailable.

## Earlier source evidence (`0d16596`)

The protocol fixture independently requires the request metadata and server identity
locations in the [2026-07-28 discovery contract](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).
The first review found and reproduced an inherited wire-shape assumption and nested
locator log leakage; both now have failing-before/passing-after HTTP fixture checks.
Those earlier findings are separate from the current pass-one inventory blockers
below. The earlier review receipt does not qualify the current fixes.

| Check | Result | Evidence on builder host |
| --- | --- | --- |
| `npm run lint` | PASS; five existing function-length warnings | `/tmp/p3-3-lint-final.log` |
| `npm run typecheck` | PASS, all workspaces | `/tmp/p3-3-typecheck-final.log` |
| `npm run check:events` | PASS, 76 event types | `/tmp/p3-3-events.log` |
| `npm test -- --maxWorkers=2` with `PG_TEST_URL` above | PASS, 69 files / 1,170 tests; 2 files / 11 tests skipped | `/tmp/p3-3-test-complete.log` |
| `npm run build -w apps/web` | PASS; bundle/CSS size warnings remain | `/tmp/p3-3-web-build-final.log` |
| `npm run test -w apps/web` | PASS, 9 files / 51 tests | `/tmp/p3-3-web-test-final.log` |
| Corrected discovery, API/replay, browser and observability fixtures | PASS, 10 files / 114 tests | `/tmp/p3-3-review-fixes.log` |

The final root run limits workers after unrelated five-second timeouts under
concurrent load. Earlier runs found the open event metadata schema and the review
bugs above; a run retaining pre-fix modules was stopped and replaced by the clean
final run. No external network calls are made by the new tests. The eleven skips are the
opt-in Kubernetes lifecycle/bridge, paid model-call and P3-2 approval-browser
qualifications. No P3-3 fixture is skipped. Source checks pass; live qualification
remains separate.

Screenshots from the authenticated Playwright journey are retained at
`/tmp/p3-3-source-1280.png`, `/tmp/p3-3-source-390.png`,
`/tmp/p3-3-review-1280.png` and `/tmp/p3-3-review-390.png` on the builder host.

At this earlier source checkpoint, the fresh-install live journey was **NOT RUN**.
The shared dev stack was left untouched.
Hosted CI and merge: **NOT RUN**; the orchestrator owns rebase, CI and landing.

## Inventory review corrections (4 October 2026)

Source: the commit containing these corrections, based on `0d16596`. Same isolated
fixture environment and PostgreSQL URL as above; no stack was touched.

Pass one found valid output schemas rejecting whole servers and malformed Tool
declarations entering durable inventory. Each correction began with a failing
test at the confirmed inventory validator seam, followed by the fix. The HTTPS
quarantine seam also reproduced the missing durable rejection evidence before
the event schema was extended. The current implementation and exclusion policy
are documented in the [server contract](../../apps/server/README.robot.md#remote-mcp-registration-p3-3).

| Regression | Failing-before evidence | Passing-after evidence |
| --- | --- | --- |
| Arrays, scalars and unconstrained output schemas; immutable definitions and both digests | `/tmp/p3-3-output-red.log` (7 failures) | `/tmp/p3-3-output-green.log` |
| Invalid header names and control characters | `/tmp/p3-3-header-red.log` (10 failures) | `/tmp/p3-3-header-green.log` |
| Prohibited header parameter types | `/tmp/p3-3-header-type-red.log` (7 failures) | `/tmp/p3-3-header-type-green.log` |
| Case-insensitive header duplicates across nested properties | `/tmp/p3-3-header-duplicate-red.log` | `/tmp/p3-3-header-duplicate-green.log` |
| Headers outside static property paths | `/tmp/p3-3-header-path-red.log` (18 failures) | `/tmp/p3-3-header-path-green.log` |
| Malformed declared fields and schemas | `/tmp/p3-3-fields-red.log` (24 failures) | `/tmp/p3-3-fields-green.log` |
| Allowed primitive unions and complete valid declarations | `/tmp/p3-3-valid-fields-red.log` | `/tmp/p3-3-inventory-final.log` |
| Whitespace and control characters in icon URIs | `/tmp/p3-3-icon-red.log` (2 failures) | `/tmp/p3-3-inventory-final.log` |
| HTTPS pagination, durable rejection reasons and worker restart | `/tmp/p3-3-durable-red.log` | `/tmp/p3-3-durable-green.log` |

Final validator run: **PASS**, 70 tests (`/tmp/p3-3-inventory-final.log`).
Required lint: **PASS**, with five existing function-length warnings
(`/tmp/p3-3-fixes-lint-final.log`). All workspace typechecks: **PASS**
(`/tmp/p3-3-fixes-typecheck-green.log`). Event catalogue: **PASS**, 79 event
types (`/tmp/p3-3-fixes-events.log`). Initial checks caught a test-table type,
the validator's complexity and missing explicit returns; these were corrected.

The initial full root run was **FAIL**: 1,295 passed, 11 skipped and four failed
(`/tmp/p3-3-fixes-test.log`). The existing chat Chromium command exceeded 180
seconds; two existing gateway budget races admitted zero successful calls, and
one gateway audit test lacked its second usage record. Lint and typecheck ran
concurrently with that run. These failures are retained as evidence, not waived.

The fresh full rerun, without concurrent lint/typecheck jobs, is **PASS**:
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2`
passed 72 files / 1,299 tests; 2 files / 11 opt-in tests were skipped
(`/tmp/p3-3-fixes-test-final.log`). The tests and timeouts were unchanged between
the two full runs. No inventory or quarantine discovery regression was skipped.

The subsequent handoff reports independent pass two: **LAND** at `4c078c9`.
Fresh-install qualification was still **NOT RUN** at that checkpoint.

## Final rebase and local checks (4 October 2026)

Rebased the two feature commits onto local `origin/main` at `bbf0bab`, including
P3-16 live view. Resulting source: `d172909`. The only conflict was in the server
README; both live-view and MCP sections were retained. `git range-diff` confirms
that the approved code is unchanged. The branch contains `origin/main`, and no
rebase remains in progress. No remote fetch was made under the external-network
restriction.

Environment: this worktree on the Linux builder, Node 22, cached test binaries and
Docker images, and disposable databases through the PostgreSQL URL above. The
initial lint and web build found missing noVNC files after the rebase. A clean
`npm ci --offline --no-audit --no-fund` restored the locked dependencies; the
following complete sequence then passed without changing production code.

| Check | Result | Builder-host evidence |
| --- | --- | --- |
| `npm run lint` | PASS; seven warnings | `/tmp/p3-3-final-lint.log` |
| `npm run typecheck` | PASS | `/tmp/p3-3-final-typecheck.log` |
| `npm run check:events` | PASS; 82 event types | `/tmp/p3-3-final-events.log` |
| `npm run build -w apps/web` | PASS; size and CommonJS warnings | `/tmp/p3-3-final-web-build.log` |
| `npm run test -w apps/web -- --watch=false` | PASS; 11 files / 56 tests | `/tmp/p3-3-final-web-test.log` |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres MODELS_REAL_CALL=0 npm test -- --maxWorkers=2` | PASS; 74 files / 1,320 tests; 3 files / 14 tests skipped | `/tmp/p3-3-final-test.log` |

The root run took 996.90 seconds. Skips are opt-in Kubernetes lifecycle, bridge
and live-view qualification, approval-browser qualification and real model calls.
No MCP discovery test was skipped. No real OpenAI call was made.

The earlier live attempt was **NOT RUN** while authentication permission was
unclear. The orchestrator has since confirmed Zitadel Cloud setup and sign-in
inside organisation `393311211338337681` are allowed. MCP traffic must still use
the local HTTPS fixture; paid model calls remain prohibited.

## Secondary live qualification (4 October 2026)

Source: `d172909`, plus the journey and public-hostname refusal explanation in
this receipt's commit. The [secondary MCP journey](../../infra/dev-stack/mcp-journey.ts)
runs after each startup mode. It replaces only the claimed secondary HTTP process
with production `buildServer` and the existing local HTTPS fixture transport.
Authentication, authorisation, events and projections use that secondary stack.
The fixture's test-only socket mapping preserves TLS hostname verification and
address pinning; no public MCP server is contacted.

The first two fresh core journeys failed before MCP qualification, in the existing
live-view journey. First: waiting for `Viewing` at desktop width instead showed
`Access changed`. Second: the mobile viewer disconnected before the test revoked
its grant. The host load was 28 on eight cores during the second failure; this is
context, not a confirmed cause. Both stacks were removed with `down.sh --id 1`.
Private diagnostics are retained on the builder at `/tmp/p3-3-failed-fresh/` and
`/tmp/p3-3-failed-retry/`. No timeout or access assertion was weakened.

A third fresh attempt passed both live-view widths, then failed the budget
journey's repeat-run assertion (`100000` cents observed, `5000` expected). Both
journey callers had treated the `dev-only-stub-journey` seed as an owner edit.
They now ignore that seed alongside `installation` when deciding fresh/repeat;
budget values and persistence assertions are unchanged. The failed-before
private log is `/tmp/p3-3-failed-third/last-error.log`.

The fourth fresh attempt passed that classification and reached the first real
budget refusal, then timed out waiting for its chat message. The private log
(`/tmp/p3-3-failed-fourth/last-error.log`) names `browser-budgets.ts:76`; the
conversation worker recorded an `agent.turn_failed` after Pod replacement. The
computer/chat cause remains unresolved. This is not an MCP failure or a pass.

The final attempt kept the running services after core failures so the MCP journey
could be measured separately. All operations used claimed secondary id `1` and
organisation `393311211338337681`. No owner-stack command or paid model call ran.

| Command / journey | Result | Evidence |
| --- | --- | --- |
| `infra/dev-stack/up.sh --fresh` | FAIL: live-view `Viewing` timeout at `browser-live-view.ts:87` | `/tmp/p3-3-up-fresh-fifth.log`; earlier failures above |
| `node --experimental-strip-types infra/dev-stack/mcp-journey.ts fresh` | PASS: all MCP assertions; fresh services | [Safe journey output](p3-3-live/fresh/journey.txt) |
| `infra/dev-stack/up.sh` | FAIL: live-view decoded-pixels timeout at `browser-live-view.ts:55` | `/tmp/p3-3-up-repeat.log`; private `/tmp/p3-3-fifth-diagnostics/last-error.log` |
| `node --experimental-strip-types infra/dev-stack/mcp-journey.ts repeat` | PASS: all MCP assertions; reused services | [Safe journey output](p3-3-live/repeat/journey.txt) |
| `infra/dev-stack/down.sh --id 1` | PASS: exit 0; claim, containers, volumes and both namespaces removed | `/tmp/p3-3-down.log` |

Both MCP runs used a real owner sign-in. Each registered one fixture URL, discovered
two paginated tools with definitions and digests, and left both blocked. HTTP was
refused before a registration request; a private IP address returned HTTP 400 with
a public-hostname explanation and no fixture connection. Reload displayed
`Outcome unknown` and `Check status`; checking restored the inventory without
another registration. The event stream contained exactly one registration and
one discovery. The fixture received only `server/discover` and two `tools/list`
requests, with pinned addresses and no forwarded authorisation or tool calls.

| Screenshot pair | Fresh | Repeat |
| --- | --- | --- |
| Inventory | [1280px](p3-3-live/fresh/inventory-1280.png), [390px](p3-3-live/fresh/inventory-390.png) | [1280px](p3-3-live/repeat/inventory-1280.png), [390px](p3-3-live/repeat/inventory-390.png) |
| Reload / Check status | [1280px](p3-3-live/fresh/reload-1280.png), [390px](p3-3-live/fresh/reload-390.png) | [1280px](p3-3-live/repeat/reload-1280.png), [390px](p3-3-live/repeat/reload-390.png) |
| Private address refused | [1280px](p3-3-live/fresh/private-refused-1280.png), [390px](p3-3-live/fresh/private-refused-390.png) | [1280px](p3-3-live/repeat/private-refused-1280.png), [390px](p3-3-live/repeat/private-refused-390.png) |
| Plain HTTP refused | [1280px](p3-3-live/fresh/http-refused-1280.png), [390px](p3-3-live/fresh/http-refused-390.png) | [1280px](p3-3-live/repeat/http-refused-1280.png), [390px](p3-3-live/repeat/http-refused-390.png) |

Post-change source checks: lint **PASS** (seven existing warnings), workspace
typecheck **PASS**, event catalogue **PASS** (82 types), web build **PASS** (existing
size/CommonJS warnings), web tests **PASS** (11 files / 56 tests), and standalone
typechecks of all three edited journey files **PASS**
(`/tmp/p3-3-live-harness-typecheck.log`). Final documentation lint and links pass. Logs: `/tmp/p3-3-live-{lint,typecheck,events,web-build,web-test,journey-typecheck}.log`.
The earlier full root suite above remains the production-source baseline; it was
not repeated for the refusal wording and dev-only journey edits.

Overall requested live qualification: **PARTIAL**. The MCP acceptance checks pass
on fresh and reused services, but the required two complete startup passes remain
**FAIL**. No capability-done or landing claim is made. Live-view reliability and
the post-replacement chat failure remain with the orchestrator for follow-up.

## Handoff outside this ticket

The existing `libs/models/src/mcp.ts` tool-call parser still uses the earlier
root-level, hyphenated metadata shape. This ticket does not publish a route or
make any discovered tool callable, so it does not exercise that parser. The
orchestrator should reconcile that existing call-path contract before qualifying
end-to-end governed calls; P3-3 discovery uses the current wire shape above.
