# P4-1 backend evidence

4 October 2026. Issue [#83](https://github.com/elewa-git/opencrane-new/issues/83),
branch `work/p4-1-groups`. Review corrections rebased the original `05db5bb` onto
main `e3bf292`, including #70 (`65364a0`), #112, #114 and #115. A second
rebase includes the newly landed #128 (`da128e2`), preserving unavailable-check
lease handling in the group desktop path. The final rebase includes #129
(`bacbfdb`), which changes only design handoff assets and documentation lint
configuration. Application, test, dependency and runner files are unchanged
from the passing full root run; documentation gates are checked after this rebase. Rebase completion
and main ancestry were checked. Changelog, ledger and benchmark history retain
both main's and the original branch's entries.

## Scope and contract

Groups reuse team events and `team#member`, assistant `acts_for` and resource
`use`. Membership, silo role, conversation participation and private memory stay
separate. Group ids are payer ids; personal defaults remain explicit. Commands
perform one conditional event append. No runtime dependency was added.

The [groups HTTP interface](../api/groups.md) owns the API contract. The members
worker runs the groups projection from its own checkpoint. PostgreSQL recovery
uses `npm run replay -- groups --verify`; OpenFGA uses the existing replay
procedure with decisions and its worker stopped. Replay has no external effects.
The owner scoped this work to the backend. The People screen remains outside
this change; the new design handoff is available for its separate UI work.

## Independent review pass 1 corrections

The review at `<home>/.fleet/p4-1-review1/last.md` found two blockers and two
readability findings. These corrections are awaiting independent pass 2.

- Approval HTTP requests capture their fence before identity and IAM reads, using
  the original request start. Member and participant removals cannot become an
  authorised baseline even when their IAM removal receipt is already applied.
- Standalone `currentAuthority` retains main's exact-subject reads, discovery and
  shared fence. The branch's replacement cache and additional fence API were
  removed. Main's authority and decision source files are unchanged.
- Command decisions, payloads, membership checks, group reads and replay switching
  now use named steps. The other new production paths and test callbacks were
  expanded using the owner's clarity rule.

Red proof restored the reviewed late approval capture and missing standalone
fence check temporarily. The applied member/participant removals returned 200;
request expiry also returned 200. The standalone revocation and expiry tests
returned a stale digest. Restoring main's fence makes those regressions refuse.
Pending-receipt removal tests deny access in both versions. Time is injected;
there are no sleeps to create the race.

## Reconciled-source verification

Environment: shared Linux development host, Node 22.23.3, existing PostgreSQL at
`postgres://postgres:test@127.0.0.1:55432/postgres`, disposable test databases,
NATS/OpenFGA fixtures and a recording gateway upstream. No daemon setup, host
network change, stack work, paid call or fresh installation.
The final commit contains this tested source; command logs are retained under
`/tmp/p4-*.log` on the builder host.

| Check | Result |
| --- | --- |
| Approval, standalone authority and group regressions | PASS in the final full root run |
| Initial combined six-file run | FAIL: 139 passed, two skipped; existing reasoning-report fixture timed out at 40 s |
| Focused confirmation | Reasoning-report, month-boundary and security cases PASS; overall FAIL because filtering omitted earlier group-journey setup steps |
| Web tests | PASS: 11 files, 60 tests |
| Event catalogue | PASS: 85 event types |
| Real volume benchmark | PASS: 100,000 unrelated events seeded into NATS, 30 samples per route and baseline |
| Root lint | PASS: all checks; eight non-blocking size warnings |
| Root typecheck | PASS across all workspaces |
| Full root suite | PASS: 84 files, 1,441 tests; four files and 15 opt-in tests skipped; 956.30 s |
| Fresh-install journey and designed screen | NOT RUN; no stack was touched |

The review's month-boundary 403 did not recur in the reconciled combined run or
focused confirmation. Its retained review log has no response body, so the exact
old refusal cannot be established. The test now includes response bodies in both
200 assertions for a useful diagnostic on any recurrence. The budget reset
implementation is unchanged; the authority path is main's #70 implementation.
The reasoning-report timeout passed in the focused confirmation without changing
that implementation or increasing its timeout.

The initial full root suite started at 14:04 UTC after
`cut -d. -f1 /proc/loadavg` returned **8**, below 16. That run was stopped when #128 landed, so it is NOT RUN to completion.
The final reconciled run started at 14:11 UTC with integer load **4**. It passed
using the requested `PG_TEST_URL`, two workers and a verbose reporter. The skipped
conditions remain unqualified. Source gates: PASS; independent pass 2 and
fresh-install capability qualification: NOT RUN.

## Retained real volume benchmark

Main's `libs/models/test/authority-volume.test.ts` is unchanged. It checks seeded
store size, exact reads, identical authority event counts, p95 below half the
service deadline and every sample below the full deadline. A test allocating
100,000 objects without seeding the store was removed during reconciliation.

| Seeded unrelated events | Route | p50 ms | p95 ms | Authority events / reads |
| --- | --- | --- | --- | --- |
| 0 | Model | 176.62 | 245.83 | 15 / 8 |
| 0 | MCP | 116.91 | 173.98 | 23 / 10 |
| 0 | Destination authority | 50.13 | 66.68 | 6 / 4 |
| 100,000 | Model | 156.41 | 222.18 | 15 / 8 |
| 100,000 | MCP | 119.16 | 151.66 | 23 / 10 |
| 100,000 | Destination authority | 43.33 | 59.92 | 6 / 4 |

Measured again in the final full root run. The earlier standalone benchmark also
passed with `PG_TEST_URL` as above and
`npx vitest run libs/models/test/authority-volume.test.ts --maxWorkers=2 --reporter=verbose --silent=false`.
These are local source measurements, not fresh-install qualification.
