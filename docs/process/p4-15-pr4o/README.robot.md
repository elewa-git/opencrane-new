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

The joined tests cover the exact structured receipt, complete dependencies, revision-two
reads, old-turn output refusal, original-command recovery, policy and identity refusals.
Held PostgreSQL locks and final-append injections cover Stop, closure, replacement,
member removal and qualification loss. Unrelated turn activity remains permitted.
The computer tests check notification filtering through the production channel.

Admission remains disabled; shared writes remain held. Full root suite, stack/model calls,
live qualification and complete disk/log leak scanning: NOT RUN.
