# Provider dependency routine presence

Part of #106. This change replaces only the routine history read used by provider
dependency requests. Provider counts, frozen run joins, member and integration
dependencies, company profiles, creation and firing remain later work.

The reader uses the existing routine table, checkpoint, generation and silo-position
index. It selects at most one position, without instructions, definitions or a count.
It requires the projection to cover the captured routine category position and checks
for rebuilds or new routine events before returning. Any saved routine, including an
older or retired record, still reports unsupported. Only a caught-up empty table
reports absent. Current member and provider permissions are checked after preparation,
including when preparation fails or expires. Unrelated chat activity remains readable.
Execution remains disabled and existing destructive-operation blockers stay in place.

## Test-first evidence

The first commit, `91f7febdc`, contains tests only. Before implementation, eight
behavioural assertions failed: the bounded read, projection lag, missing checkpoint,
failed database read and four database race checks. Nine existing behaviours passed.
One additional failure came from an invalid active-routine fixture; that fixture was
corrected. The first corrected run passed 44 tests. Later checks also cover expiry
before the access checks. These results are from disposable services, not a live silo.

## Checks

| Check | Result |
| --- | --- |
| Worktree `npm ci` and requested tool links | PASS |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS, 154 event types agree |
| `npm run lint:changelog` | PASS |
| Lint stages, including Knip | PASS, resumed after the Markdown fix |
| Changed tests, final implementation | PASS, 46 tests twice |
| Provider binding guards and drain tests | PASS, 58 tests |
| `libs/events/test/security-rules.test.ts` | PASS, 438 tests once |
| Routine projection tests | PARTIAL, four passed and one failed |

FAIL: `runs the worker and guarded replay entrypoints using only reader credentials`
in `libs/projections/test/routines.test.ts:254`. The worker checkpoint remained 0;
the test expected 3 after its wait. The supplied prior task report also records this
worker-startup failure. No retry was run and no worker files were changed. The four
in-process projection tests passed, including replay equality, no effects, frozen runs
and rollback. This broader batch finished with 546 passed and one failed.

The changed suites are `apps/server/test/provider-routine-presence.test.ts` and
`apps/server/test/provider-bindings.test.ts`. Run them with
`PG_TEST_URL` pointing to a disposable database and
`nice -n 10 node_modules/.bin/vitest run <files> --maxWorkers=1 --no-file-parallelism`.
The final two runs are recorded in `/tmp/p4-24-pr7a-pass2.log` and
`/tmp/p4-24-pr7a-pass3.log`. Other logs use `/tmp/p4-24-pr7a-` followed by
`red`, `pass1`, `lint`, `lint-rest`, `typecheck`, `events` or `changelog`, and `.log`.
The full lint command passed code, dependency and Knip checks, then found one extra
blank line in the updated robot README. That line was removed; the remaining lint
stages were resumed. The dependency and Knip checks were also repeated after rebase.

Tests, typecheck and ESLint ran on `e063b98f1` plus this change. The branch was then
rebased onto `7b0f48cc8` (#704). The owned provider code and tests are byte-for-byte
unchanged by that rebase. Existing README edits from #702, #703 and #704 are retained.
Overall qualification remains PARTIAL because of the worker-startup failure.

## Scope and environment

`npm ci` installed dependencies in this worktree. The NATS and Lychee tools are symlinks
to the requested local binaries. Tests use real disposable NATS, PostgreSQL and OpenFGA.
PostgreSQL 17.6 ran in `pgtest-p4-24-pr7a` on a random loopback port, following the
throwaway-database instruction. The container and its volume were removed with
`docker rm -f -v`. Every test, lint and typecheck command uses `nice -n 10`;
tests use one worker. No new dependency, event type or API field was added.
The security field-name rule and both authority test files are unchanged.

NOT RUN: full root suite, fresh-install live qualification, stacks and model calls.
CI will not be awaited after the draft PR is opened.

## Access and fixture corrections

Rebased onto `5d3bfadc5` and confirmed that it is an ancestor of this branch.
The rebase finished with a clean worktree before these corrections.

Provider inventory now loads inside the deferred dependency preparation. A separate
read takes only the requested provider's creation record for its permission check.
Current membership and provider permission are checked before reporting an inventory
failure. Removed administrators, ordinary members and callers requesting a missing
provider still receive 403. An authorised administrator receives a fixed 503 response.
Execution remains disabled.

Test-only commit `9e1c66fcd` came first. Nine assertions failed with 503 instead of 403
for failed, expired and malformed inventory reads. The three authorised-administrator
cases passed. After the fix, all 12 cases passed. They also check that private error
details stay out of replies and logs and that no events are appended.

Test-only commit `bdf4ca6b6` added a healthy GET before each assistant-lag,
assistant-change and provider-change fault. All three failed because the fixture
lacked routine data. Initialising the routine projection supplies its table and
checkpoint. All three then passed, including their original 503 assertions.

The correction checks use `nice -n 10` and one test worker. They use disposable NATS
and OpenFGA fixtures and a dedicated PostgreSQL 17.6 container,
`pgtest-p4-24-pr7a-fixes`, on random loopback port 39719. This follows the throwaway
database instruction. No owner stack, secondary dev stack or model call is used.
The throwaway database container and volume were removed with `docker rm -f -v`.

| Correction check | Result |
| --- | --- |
| Inventory error regressions | PASS, 12 cases after the expected failing run |
| Healthy reads before history faults | PASS, three cases after the expected failing run |
| Provider presence, bindings, guards and drain suites | PASS, 116 tests twice |
| Workspace, package and dev-stack typechecks | PASS |
| Full lint pipeline, including Knip | PASS, zero errors and 25 existing code warnings |
| Event catalogue | PASS, 154 event types agree |
| Changelog | PASS |

Both complete provider runs use the same final code. Logs are
`/tmp/p4-24-pr7a-fixes-pass1.log` and `/tmp/p4-24-pr7a-fixes-pass2.log`.
The test-first logs are `/tmp/p4-24-pr7a-fix1-red.log` and
`/tmp/p4-24-pr7a-fix2-red.log`; their targeted passing runs replace `red` with `green`.
Other check logs use `/tmp/p4-24-pr7a-fixes-` followed by `typecheck`, `events`,
`changelog` or `lint`, and `.log`.

NOT RUN in this correction: full root suite and fresh-install live qualification.
The earlier routine-worker result above is unchanged; that suite was not rerun here.
The PR remains a draft. CI will not be awaited after pushing.
