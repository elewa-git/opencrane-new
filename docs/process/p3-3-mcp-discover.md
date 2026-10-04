# P3-3 remote MCP discovery

Issue #44, parent #41; decisions D09–D10. Source: the commit containing this receipt,
stacked on P3-2. OC1 source commit: `10abd0ef6182f36bec13d8f1358e43b15ead7cd5`.
Run date: 4 October 2026. Environment: Linux, Node 22.23.3, isolated NATS/OpenFGA fixtures and disposable PostgreSQL
databases via `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
No dev stack was touched. No remote provider or paid call is part of these tests. New runtime packages were
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

Fresh-install live journey: **NOT RUN**; no capability-done claim. The shared dev
stack was left untouched.
Hosted CI and merge: **NOT RUN**; the orchestrator owns rebase, CI and landing.

## Inventory review corrections (4 October 2026)

Source: the commit containing these corrections, based on `0d16596`. Same isolated
fixture environment and PostgreSQL URL as above; no stack was touched.

Pass one found valid output schemas rejecting whole servers and malformed Tool
declarations entering durable inventory. Each correction began with a failing
test at the confirmed inventory validator seam, followed by the fix. The HTTPS
quarantine seam also reproduced the missing durable rejection evidence before
the event schema was extended. The current implementation and exclusion policy
are documented in the [server contract](../../apps/server/README.md#remote-mcp-registration-p3-3).

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

Independent second-pass verification of these corrections: **NOT RUN**; pending
the orchestrator's review. Fresh-install qualification remains **NOT RUN**.

## Handoff outside this ticket

The existing `libs/models/src/mcp.ts` tool-call parser still uses the earlier
root-level, hyphenated metadata shape. This ticket does not publish a route or
make any discovered tool callable, so it does not exercise that parser. The
orchestrator should reconcile that existing call-path contract before qualifying
end-to-end governed calls; P3-3 discovery uses the current wire shape above.
