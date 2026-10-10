# Provider choices at turn admission

Date: 9 October 2026. Branch: `work/p4-22-pr4c`.
Base: `origin/work/p4-22-pr4b`. Test-first commit: `feddd6a5`.
Environment: Node 22.23.3, local worktree, disposable NATS/OpenFGA/gateway services and PostgreSQL
at `127.0.0.1:55432`. This is not a fresh customer install. No paid provider calls.

The first part adds own/default admission after the recorded switch-on marker,
old-pass refusal and checks for a mode change before money is held. It adds no
production switch-on command or reaction. Safe migration, draining running legacy
turns, managed gateway activation and fallback-key startup refusal remain separate work.

| Check | Result |
| --- | --- |
| Failing-first tests | PASS: 7 failed, 12 passed before implementation |
| First broader focused run | PASS: 84 tests in 7 files |
| Final tests | PASS: 115 tests in 10 files; all 50 tests in the 4 changed files passed again |
| Lint, typecheck, event catalogue, knip and changelog | PASS; 100 event types agree |
| Independent review | PASS: two passes; fixed a read-count assertion and kept an existing error message |
| Binding revision guard | PASS: 1 selected test; 37 skipped intentionally |
| Reviewer long-chat and read-during-turn-start checks | PASS: 2 targeted tests |
| Full root test suite | NOT RUN, as requested |
| Fresh-install migration and managed dispatch | NOT RUN |

The final batch sets `PG_TEST_URL` and runs Vitest under `nice -n 10` with one worker:

```sh
npx vitest run apps/server/test/provider-turn-admission.test.ts apps/server/test/provider-bindings.test.ts apps/server/test/computer-turns.test.ts apps/server/test/turn-admission-cost.test.ts libs/models/test/provider-turn-contract.test.ts libs/models/test/provider-turn-guards.test.ts libs/models/test/provider-turn-replay.test.ts libs/models/test/decision-activity.test.ts libs/events/test/registry.test.ts libs/events/test/parse.test.ts --maxWorkers=1
```

Local logs: `/tmp/p4-22-pr4c-red.log`, `/tmp/p4-22-pr4c-focused.log`,
`/tmp/p4-22-pr4c-final-tests-1.log`, `/tmp/p4-22-pr4c-final-tests-2.log`, `/tmp/p4-22-pr4c-final-tests-3.log`,
`/tmp/p4-22-pr4c-lint.log` and `/tmp/p4-22-pr4c-final-typecheck.log`.
The pull request records the final source commit. These checks establish source
readiness for this slice, not completion of the managed-provider capability.

## Access-boundary correction after rebase

Date: 10 October 2026. Source: `4dc987796ec064eb82601a0646e4f0f9a88109a0`.
Rebased only this branch's two original commits onto `dc2f0351` from `origin/main`.
The rebase finished. Kept the merged role and group-participant documentation.
Environment: Linux, Node 22, local worktree; disposable NATS, OpenFGA and recording
gateway; PostgreSQL test server at `127.0.0.1:55432`. This is not a fresh install.

Model decisions now read switch-on from `budget-<silo>`, never `provider-*`.
The event parser rejects switch-on on another stream. Saving that marker also
stops an old budget writer from holding more money. Provider metadata replay
keeps its own stream position. Refused bound calls still hold and spend zero cents.
Decision audits use a fresh command id and `historyChecked`.

PASS: all four changed test files plus both unchanged authority test files,
twice, 56 tests per pass. The second pass also ran the event parser and registry
checks: 84 tests across eight files in total. Both runs set `PG_TEST_URL` and use
`nice -n 10` with one worker. The 100,000-event guard passes without wildcard reads.
PASS: full lint, root typecheck, event catalogue (100 types), Knip and changelog.
The first lint run found a complexity error; a named subject check fixed it.
The final lint run has 15 existing warnings and no errors.

Logs: `/tmp/p4-22-pr4c-tests-1.log`, `/tmp/p4-22-pr4c-tests-2.log`,
`/tmp/p4-22-pr4c-lint-final.log` and `/tmp/p4-22-pr4c-typecheck.log`.
NOT RUN: full root suite, paid provider calls, fresh-install managed-provider
qualification and another independent review of this correction.

## Settlement after provider switch-on

Date: 10 October 2026. Source: `475b0053e7994e686fd54fcc3ff86d953676ad25`.
Rebased only this branch's four commits from `47cd8db0` onto `origin/main`
at `471e22cc`. The rebase finished. Kept main's approval documentation.
Environment: Linux, Node 22.23.3, local worktree; disposable NATS and OpenFGA,
a recording gateway and PostgreSQL at `127.0.0.1:55432`. This is not a fresh install.
No paid provider calls were made.

The actor now reads only events after its saved budget position when an append
conflicts. If they are all switch-on markers, it refuses new holds without
stopping the actor. It retries settlement and other budget changes once after
those markers. A spending-limit retry checks access again within the original
deadline. Another budget writer's changes still stop the old actor.

Failing-first commits: `84cbcc72` and `fb9cbd29`. The tests first reproduced
unreleased unsent holds during the allow audit and final permit queue, a late
usage settlement conflict and a spending-limit retry after access expired.
An interim broad batch had 78 passes and that one access-retry failure.
The committed fix passed all 79 tests in the first final seven-file batch.
Both authority files are unchanged from main, including the 100,000-event guard.
PASS: the second final run passed all 75 tests in the five changed test files.

The new checks prove zero-cost release after a refused decision, one settlement
per dispatched call at exactly one cent, and continued settlement, release and
expiry on the same actor. They also prove that refusing a new hold does not stop
that progress and that a replacement budget writer still stops the old actor.
The replay test now sends its request through the replayed actor. A separate
activity test refuses switch-on without relying on a budget append conflict.

PASS: root lint, root typecheck, event catalogue (103 types), Knip and changelog.
Lint reports 15 existing warnings and no errors. A final ESLint check of the
actor and edited model tests also passed. Tests set the documented test-only
`PG_TEST_URL` and run under `nice -n 10` with one worker.

Logs: `/tmp/p4-22-pr4c-settlement-red.log`,
`/tmp/p4-22-pr4c-settlement-red-usage.log`,
`/tmp/p4-22-pr4c-settlement-red-access.log`,
`/tmp/p4-22-pr4c-settlement-final-1.log`,
`/tmp/p4-22-pr4c-settlement-final-2.log`,
`/tmp/p4-22-pr4c-settlement-lint.log`,
`/tmp/p4-22-pr4c-settlement-typecheck.log` and
`/tmp/p4-22-pr4c-settlement-final-eslint.log`.

NOT RUN: full root suite, fresh-install managed-provider qualification,
paid calls and another independent review. Switch-on still has no production
command; the managed-provider capability remains unfinished.
