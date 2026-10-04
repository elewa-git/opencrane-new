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

## Evidence

The protocol fixture independently requires the request metadata and server identity
locations in the [2026-07-28 discovery contract](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).
The first review found and reproduced an inherited wire-shape assumption and nested
locator log leakage; both now have failing-before/passing-after HTTP fixture checks.
Final independent review: **PASS**, second of two passes. Both blockers were
verified fixed; no further code blocker was found. No code changed after that review.

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

## Handoff outside this ticket

The existing `libs/models/src/mcp.ts` tool-call parser still uses the earlier
root-level, hyphenated metadata shape. This ticket does not publish a route or
make any discovered tool callable, so it does not exercise that parser. The
orchestrator should reconcile that existing call-path contract before qualifying
end-to-end governed calls; P3-3 discovery uses the current wire shape above.
