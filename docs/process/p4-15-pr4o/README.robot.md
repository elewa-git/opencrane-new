# Correct delivery checks

Part of #97. Built from `2e860bac3` after #888 merged at
`4ae99f3d07ec15c3a576f5af4548f362add37b18`.
That prerequisite includes its saved Stop and replacement repair.
Tests were committed first as `6f281501b`.

## Contract

Only Correct is added to the existing private Recall/Remember offer. Forget stays excluded.
The same admitted thread, caller, qualification, preparation, proxy and backend are used.
Public discovery and input schemas are unchanged. Correct retains every other loaded
reference and excludes every revision of the target from its dependencies.
The original write positions and deadline survive full confirmation at append.
Correct rechecks deployment qualification before saving and within that callback.
Scope and conversation history remain in preparation before the short access check.
No event, API field, dependency, SQL rule or admission setting changes.

## Own checks

Environment: 6 November 2026, Node 22, Linux worktree; disposable NATS, OpenFGA and
PostgreSQL 17.6. This is not a fresh deployment. The native peer is scripted; no model runs.
`npm ci` completed; NATS and Lychee link to the supplied local binaries.

Expected failures: the computer refused the three-tool list and backend startup failed
before Correct was offered. With the offer enabled, three qualification cases saved a
revision when they should have refused. An initial attempt lacked the gateway fixture
binary; normal `npm test` setup fetched it before the failing-first rerun.
Logs: `/tmp/p4-15-pr4o-red.log`, `/tmp/p4-15-pr4o-guards-red.log`.

Final own checks: PASS. Commands used `nice -n 10`; tests used one worker and no file
parallelism, with `PG_TEST_URL` set to the task-owned database.

| Check | Result |
| --- | --- |
| Lint, typecheck, event catalogue, Knip, changelog | PASS |
| Six affected suites, first run | PASS, 306 tests |
| Same six suites, second run | PASS, 306 tests |
| Unchanged security rules, first run only | PASS, 460 tests |

The server typecheck also passed after the final helper extraction. Initial test setup
errors and the first lint complexity error were fixed before these final results.
Final logs: `/tmp/p4-15-pr4o-tests1.log`, `/tmp/p4-15-pr4o-tests2.log`,
`/tmp/p4-15-pr4o-lint2.log`, `/tmp/p4-15-pr4o-typecheck2.log` and
`/tmp/p4-15-pr4o-typecheck-server.log`. GitHub CI is reported on the draft PR's pushed head.

CI on `a11f04f51`: FAIL. Existing Correct fixtures supplied a saved initial load without
deployment qualification, so 24 cases correctly received a refusal. Those fixtures now
provide qualification through the existing helper and restore their mocks after each test.
The server typecheck and full lint passed after this fixture repair. All 50 Correct and
correction cases in `memory-mcp.test.ts` passed twice; 174 unrelated cases were skipped.
Logs: `/tmp/p4-15-pr4o-compat1.log`, `/tmp/p4-15-pr4o-compat2.log`,
`/tmp/p4-15-pr4o-lint3.log` and `/tmp/p4-15-pr4o-typecheck-compat.log`.

The joined tests cover the exact structured receipt, complete dependencies, revision-two
reads, old-turn output refusal, original-command recovery, policy and identity refusals.
Held PostgreSQL locks and final-append injections cover Stop, closure, replacement,
member removal and qualification loss. Unrelated turn activity remains permitted.
The computer tests check notification filtering through the production channel.

Admission remains disabled; shared writes remain held. Full root suite, stack/model calls,
live qualification and complete disk/log leak scanning: NOT RUN.

## Delayed receipts and partial tool lists

Rebased on `64b78321f`. Test commit `1b3b49f23` precedes these fixes.
The failing-first run reproduced 12 failures: five saved receipts escaped after Stop,
closure, replacement, membership removal or deadline expiry, and seven valid offers
were refused. The other 44 cases passed. Log: `/tmp/p4-15-pr4o-repair-red.log`.

Correct now repeats its existing full confirmation after saving, retaining the original
access positions and deadline. The saved correction remains durable when its receipt is
withheld. Tests delay the append acknowledgement and keep the local caller registered.
They check the exact withheld reply, qualification loss and permitted unrelated activity.
Full conversation history remains outside the short access check.

The computer accepts every non-empty subset of Recall, Remember and Correct in that
order. Each tool still needs Allow, and loading still requires the exact original list.
The tests use the production server builder and native discovery fixture for all seven
subsets, including Recall/Correct when Remember is Block, Ask or unreviewed. Wrong tools,
duplicates, changed order, empty or oversized lists and mismatched modes remain refused.

Admission remains disabled. The full root suite, live qualification, development stacks
and model calls are NOT RUN for these repairs.

Own test results on 6 November 2026, Linux, Node 22.23.3, test commit `1b3b49f23`
plus these fixes: PASS, the four targeted suites twice, 106 tests per run. The suites
are computer `private-recall-catalogue`, `private-recall-preflight`,
`private-recall-runner` and server `correct-backend-delivery`. The 51 selected existing
Correct/correction cases in `memory-mcp.test.ts` also passed across two subsets.
Every test command used `nice -n 10`, one worker, no file parallelism and the supplied
`PG_TEST_URL`. The test helpers managed disposable databases and services.

Initial overlapping runs recorded two failures: the existing stale-output case received
a withheld receipt, and the slow backend IAM case exceeded its access deadline.
The stale-output case passed alone. After separating tests from lint, the compatibility
rerun and both complete targeted runs passed. No deadline, access check or assertion
was relaxed. The failed runs remain recorded rather than counted as passes.

Passing logs: `/tmp/p4-15-pr4o-repair-tests2.log`,
`/tmp/p4-15-pr4o-repair-tests3.log`, `/tmp/p4-15-pr4o-repair-compat.log` and
`/tmp/p4-15-pr4o-repair-compat3.log`. Initial failed logs:
`/tmp/p4-15-pr4o-repair-tests1.log` and `/tmp/p4-15-pr4o-repair-compat2.log`.
The isolated stale-output check is in `/tmp/p4-15-pr4o-repair-output-diagnostic.log`.

Final source checks: PASS — full lint, including Knip and changelog validation;
full typecheck; and `check:events` with 158 matching event types. The final test-helper
imports also passed computer/server typecheck and targeted lint.
The first lint attempt was stopped near Node's default heap limit: PARTIAL.
The completed run used the same 8 GB heap setting as CI, still under `nice -n 10`.
No lint rule or application check changed.
Logs: `/tmp/p4-15-pr4o-repair-lint2.log`, `/tmp/p4-15-pr4o-repair-typecheck.log`,
`/tmp/p4-15-pr4o-repair-events.log`, `/tmp/p4-15-pr4o-repair-computer-types.log`,
`/tmp/p4-15-pr4o-repair-server-types.log` and
`/tmp/p4-15-pr4o-repair-final-test-lint.log`.
