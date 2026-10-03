# P3-1 — Per-tool policy evidence

3 October 2026; branch `work/p3-1-policy`, base main `e897361` plus the change
containing this receipt. Linux x86-64, Node 22.23.3. Disposable NATS/OpenFGA/gateway
fixtures and isolated PostgreSQL databases on
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The shared dev stack was not changed. No paid calls, push or deployment.

## Architecture and behaviour

The existing org register links to Tools & access (admin frame 4d). Owner/Admin
commands check live OpenFGA and event membership, bind installed connection/tool
revision, and append once conditionally. Retries are idempotent; concurrent editors
must reload after a conflict. Discovery hints do not grant access. Legacy name-only
modes do not grant execution. New/unreviewed tools remain Block; drift invalidates
review and modes until rediscovery/review.

The existing ext_authz decision process handles both model and fixed MCP fixture
routes. S0.2's bounded bodies, strict tokens, duplicate-key checks and header
allowlist are reused. Each decision requires live requester and assistant resource
grants, current membership/teams, conversation, active assistant/computer/turn,
thread/generation/delegation and paying-group binding. Relevant event receipts
fence lagging OpenFGA projections. The fixture explicitly has no external account;
no profile, secret or memory grant is invented. Ask never forwards. Allow includes
the first write. Admission events precede forwarding and are separate from effects.

PostgreSQL stores the same TypeScript-folded tool policy as decision reads and can
be dropped/rebuilt. OpenFGA is also rebuilt from events. No business rules in SQL.
No new third-party version: projections now explicitly declares the already pinned
Zod 4.6.5; its installed MIT licence was reviewed.

## Evidence

The real gateway tests assert actual upstream counts for first-write Allow,
Ask, Block, unknown/prototype names, unreviewed tools, token/context mismatch,
requester and assistant grant revocation, lag, inactive assistant, unavailable
OpenFGA, missing personal account context, quarantine and audit failure. The
revocation test checks both pre-projection and post-projection refusals within two
seconds. Existing lifecycle tests cover expired, suspended/lost/replaced computers
and ended turns. Team membership removal refuses even before OpenFGA catches up.

The authenticated API tests cover Owner/Admin versus member/foreign identities,
Origin, repeat commands, concurrent edits, connection/revision mismatch and replay.
Chromium verifies real API saves, keyboard controls, layout width and 44px controls.
UI tests cover pending, uncertain/error, status reconciliation and access change.

- [Desktop](evidence/p3-1/tools-desktop.png)
- [390px](evidence/p3-1/tools-390.png)

Two existing concurrent-budget vectors failed during the initial busy-box focused
run; both passed together in isolation. That rerun used
`npx vitest run libs/models/test/gateway.test.ts -t 'admits one last reservation'`.
Initial red tests demonstrated missing discovery fields, missing OpenFGA grant
handling and the absent tools link. The browser fixture's dynamic Origin was fixed
without weakening the production Origin check. The initial root run also caught a
schema field name suggesting credential material; it is now the strict enum
`accountMode`, and the security-schema suite passes.

Independent review pass 1 found that different streams could reorder a grant
and revoke. The fix enforces `grantStream(resourceType, resourceId)` in the
OpenFGA reaction. The regression failed before the fix, then passed with real
NATS, pg-boss/PostgreSQL and OpenFGA: alternate subjects are rejected, the ordered
worker leaves grant→revoke denied, duplicate grant delivery stays denied, and a
fresh OpenFGA rebuild matches. Fixtures now use the same resource stream.

Independent review pass 2 confirmed the ordering blocker resolved and found no
further blockers. The browser fixture disables dependency prebundling so a prior
Angular serve cannot retain an old workspace protocol schema after an edit.
The complete authorisation suite exposed shared dispatcher state in the new
ordering regression; that fixture now uses its own database. Its event envelopes
also explicitly include empty correlation. All 11 authorisation tests pass together.

## Local gates

| Command | Result |
| --- | --- |
| `npm ci` | PASS, clean install |
| `npm run lint` | PASS, all five checks |
| `npm run typecheck` | PASS, all workspaces |
| `npm run check:events` | PASS, 74 event types |
| `npm test -- --maxWorkers=2` with the PostgreSQL URL above | PARTIAL: 1,022 passed, 1 timing failure, 3 skipped; 440 seconds |
| Isolated gateway policy rerun, same PostgreSQL URL | PASS, including the unchanged two-second revocation bound; 27.58 seconds |
| `npm run build -w apps/web` | PASS, existing app.css size warning |
| `npm run test -w apps/web -- --watch=false` | PASS, 43 tests / 5 files |

The root suite includes the real gateway, NATS, PostgreSQL and OpenFGA fixtures
and the Chromium desktop/390px journey. The paid model call and two live cluster
suites are opt-in and remain skipped. No timing threshold was relaxed.
The final full run's sole failure was the revocation measurement: 3,591.6ms
against 2,000ms while the box was busy. Both gateway refusals had already returned
403. The unchanged rerun passed using
`npx vitest run libs/models/test/gateway.test.ts -t 'enforces reviewed tool modes'`.
This is isolated passing evidence, not a claim that the aggregate run was green.
An uncontended aggregate run and hosted CI remain needed before landing.

## Not run

Fresh Phase 3 dev-stack journeys, real Odoo/credential release, approval creation
and consumption, paid provider calls, gVisor MCP computer transport, hosted CI,
Helm/HA and managed-cluster qualification: **NOT RUN**. These fixtures establish
source behaviour, not the Phase 3 fresh-install capability-done claim.
The installer, discovery transport, approval binding, personal connections,
group ceilings and audit UI remain their owning Phase 3 tickets.

Existing silos need a rebuilt OpenFGA model and explicit model grants before
switching decision versions. The event-head scan is intentionally simple and has
linear history cost; high-volume qualification requires a fenced IAM projection.
