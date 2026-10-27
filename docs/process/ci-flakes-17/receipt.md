# Cluster route readiness checks

Date: 27 October 2026. Part of #576.

Latest result: PASS. The corrected fixture passed all 30 loaded runs.
The earlier failed series remain below, followed by the
[final results](#final-loaded-series).

## Source and environment

Base: `0ba702c6e3ed062e7ff812875f9de873d41da4b3`.
Failing-test commit: `9d342889b`.
Implementation: `65b5d2ad01c89083907012de8839aba7b3df983a`.
The original final commit added this receipt only.
A fresh worktree ran `npm ci` with Node 22.23.3. It used NATS 2.15.0 and Lychee 0.23.0.
The tests started disposable NATS servers and a separate PostgreSQL 17.6 container.
All checks and tests used `nice -n 10`. No full root suite or live journey ran.
The throwaway database and its volume were removed after the tests.

## Cause

The original attempt of [main CI run 40442729405](https://github.com/elewa-git/opencrane-new/actions/runs/40442729405/attempts/1)
failed in `completeRoutes`: seven routes arrived instead of eight, with one
`peer-2/pooled` route missing. The subsequent CI attempt passed.

A temporary, read-only fetch wrapper recorded actual `/routez` responses during
three baseline runs. It copied responses for observation and returned the original
responses unchanged. These runs used two parallel test files, alongside another
test process, with both processes restricted to the same two CPUs.

The trace captured seven routes followed by eight on the same server 50 ms later.
The seven contained two `peer-2/pooled` routes, both `$SYS` routes and three
`peer-3/pooled` routes. The next response included the third `peer-2/pooled` route.
Other observations also showed pooled connections arriving after system connections.

| Observation | peer-2 pooled | peer-2 $SYS | peer-3 pooled | peer-3 $SYS | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| First response | 2 | 1 | 3 | 1 | 7 |
| 50 ms later | 3 | 1 | 3 | 1 | 8 |

No process was restarted or reconfigured between these observations.
This demonstrates a partial route list while a real connection is still forming.
It does not establish how long the missing route in the original CI attempt took.

The old `ready()` already retried the whole three-peer check for ten seconds.
`completeRoutes` itself checked only one response, and later peers shared the time
already spent on earlier peers. The change gives each peer its own bounded route
wait of twenty seconds and preserves every required route, including repeated
pooled routes.
A route that never arrives still fails with the actual and expected lists.
The twenty-second limit also gives the first peer more time than the former
shared ten-second wait, which already retried the snapshots.

Local raw logs are in `.tools/route-observations.jsonl`, `.tools/baseline-*.log`
and `.tools/ci-original-failure.log`. They are not shipped in runtime images.

## Failing-first regression

PASS: the first test commit failed on the old implementation because its first
response had seven routes. The failure contained seven actual and eight expected
route descriptions. It did not fail from missing infrastructure or imports.
Additional deadline cases failed before the fix as well.

The regression checks a late eighth route and immediate acceptance of a complete,
unordered response. Deadline cases retain missing pooled and system routes, extra
pooled routes, and a wrong account even when the count is eight. A controlled clock
checks that incomplete routes remain pending until exactly twenty seconds.
Another case lets the final route arrive at eleven
seconds, after the earlier shared deadline. A request which expires at the deadline
must also retain the actual and expected route lists.

Baseline results: run 1 PASS (62 tests, 129.18 s), run 2 PASS (62 tests,
138.71 s), run 3 PASS (62 tests, 137.65 s). Each companion run passed 22 tests.
Two preliminary loaded runs of the ten-second implementation passed 68 tests each.
Two runs of the first twenty-second implementation passed 69 tests each. A third
preliminary run was stopped from continuing while code changed. Its already running
workers used the previous fixture with the new final-request regression: FAIL,
69 passed and one failed. The failed case received the raw request error instead
of route lists. Fresh focused runs passed after the fix. These preliminary runs
are excluded from the final sequence. Their logs remain in `.tools/loaded-precheck/`
and `.tools/loaded-before-final-request-fix/`.

## Checks

| Check | Result |
| --- | --- |
| `npm ci` | PASS |
| Full lint, including documentation, links and licences | PASS |
| Full typecheck and final affected-package typechecks | PASS |
| `check:events` | PASS, 156 event types |
| Knip | PASS |
| `lint:changelog` | PASS |
| Eight final route regressions, twice | PASS |
| Event security rules | PASS, 460 tests |
| Loaded repetition series | FAIL, 26 PASS and 4 FAIL |
| Real cluster-route suite and route regressions | PASS in all 30 runs |
| Companion suites | PASS, 305 suites and 213805 tests |
| Full root suite and live fresh-install journeys | NOT RUN, outside this change |

The first full lint attempt failed on two test-helper lint errors; both were fixed.
The loaded series keeps every failure. No failed numbered run was retried.

- Run 2: FAIL. The five-second `waitForClusterStream` placement wait expired in
  `preparePlacementStatistics`, before bootstrap's late `$JS.API.INFO` reply case.
- Run 16: FAIL. The existing check in `cluster-failover.test.ts` received an undefined
  `info.cluster?.leader` when it expected a peer name.
- Run 20: FAIL. The five-second placement wait in `cluster-fixture.ts` expired while
  `cluster-failover.test.ts` prepared its drill.
- Run 23: FAIL. It repeated the undefined-leader failure from run 16.

All four runs passed the route checks and their companion suites. Stream placement
and failover checks remain unchanged. The broader cluster qualification is FAIL.

## Loaded repetition command

The final sequence runs these selected files together, with file parallelism:

```sh
nice -n 10 node node_modules/vitest/vitest.mjs run \
  infra/package/bootstrap.test.ts libs/event-store/test/cluster \
  libs/event-store/test/route-readiness.test.ts \
  --maxWorkers=2 --fileParallelism --reporter=default --reporter=json \
  --outputFile.json=.tools/loaded-runs/run-N.json
```

A second process repeatedly runs the following command until that repetition ends.
Only one companion test process runs at a time. Each companion suite must pass.
The security rules are excluded here because they were checked separately.

```sh
nice -n 10 node node_modules/vitest/vitest.mjs run libs/events/test \
  --exclude=libs/events/test/security-rules.test.ts --maxWorkers=2 --fileParallelism
```

The target must pass 70 tests in six files every time. Each companion run checks
701 tests in 33 files. Both commands use the throwaway database settings described
above, although the companion tests do not need a database.
Raw logs and JSON reports are in `.tools/loaded-runs/`.

## Every loaded run

Seconds measure the target process. Each companion count includes only complete,
passing runs of its 701-test suite. Every target ran 70 tests in six files.

| Run | Target | Tests passed | Seconds | Companion suites |
| ---: | --- | ---: | ---: | --- |
| 1 | PASS | 70/70 | 145 | PASS, 8 |
| 2 | FAIL | 69/70 | 167 | PASS, 8 |
| 3 | PASS | 70/70 | 132 | PASS, 9 |
| 4 | PASS | 70/70 | 124 | PASS, 9 |
| 5 | PASS | 70/70 | 125 | PASS, 9 |
| 6 | PASS | 70/70 | 154 | PASS, 10 |
| 7 | PASS | 70/70 | 149 | PASS, 8 |
| 8 | PASS | 70/70 | 148 | PASS, 9 |
| 9 | PASS | 70/70 | 157 | PASS, 10 |
| 10 | PASS | 70/70 | 144 | PASS, 11 |
| 11 | PASS | 70/70 | 141 | PASS, 11 |
| 12 | PASS | 70/70 | 134 | PASS, 10 |
| 13 | PASS | 70/70 | 136 | PASS, 9 |
| 14 | PASS | 70/70 | 132 | PASS, 9 |
| 15 | PASS | 70/70 | 139 | PASS, 11 |
| 16 | FAIL | 69/70 | 139 | PASS, 10 |
| 17 | PASS | 70/70 | 136 | PASS, 12 |
| 18 | PASS | 70/70 | 124 | PASS, 11 |
| 19 | PASS | 70/70 | 108 | PASS, 10 |
| 20 | FAIL | 69/70 | 131 | PASS, 12 |
| 21 | PASS | 70/70 | 107 | PASS, 10 |
| 22 | PASS | 70/70 | 128 | PASS, 12 |
| 23 | FAIL | 69/70 | 113 | PASS, 10 |
| 24 | PASS | 70/70 | 124 | PASS, 11 |
| 25 | PASS | 70/70 | 121 | PASS, 10 |
| 26 | PASS | 70/70 | 128 | PASS, 12 |
| 27 | PASS | 70/70 | 139 | PASS, 12 |
| 28 | PASS | 70/70 | 122 | PASS, 10 |
| 29 | PASS | 70/70 | 143 | PASS, 11 |
| 30 | PASS | 70/70 | 132 | PASS, 11 |

## Follow-up fixture readiness checks

Date: 27 October 2026. The earlier 26 PASS / 4 FAIL series above remains recorded.
This follow-up uses base `039d6c5b9d82cf28604674728c0864d40e3cf27a` after
`git fetch origin` and a completed rebase onto `origin/main`.
The branch was rebased again at the boundary after run 21, onto
`3763f17c71b13257da26ae8fb9523583e7aed5c0`, after fetching origin again.
Both rebase state directories were checked through Git's worktree paths and were absent.
The fetched base is an ancestor of the branch. All apps, libraries, NATS settings
and selected bootstrap sources are unchanged across this second rebase.
The same numbered series continues from run 22; no completed run is retried.
Runs 1–21 used `a73249d0b`. Runs 22–30 used the rebased source `fa24a7056`.

The earlier failures in runs 16 and 23 came from the EVENTS **stream** leader check
in `survivingQuorum`, after stopping a peer. Those logs do not establish a missing
metadata leader. Product bootstrap and its 120-second deadline remain unchanged.

The fixture now polls actual health and `/jsz` reports for at most 20 seconds per
peer. It requires storage statistics, a named metadata leader and the leader's
report of all three distinct current, online peers. A follower only tracks its
own link to the leader, so its current flags cannot establish whether the other
follower is current. The last observed metadata remains in an expiry failure.

HTTP reports cannot show the leader's cached placement statistics for other
servers. The shared placement helper therefore polls actual R3 creation, retrying
only the exact typed peer-offline refusal. It allows 20 seconds in the fixture,
retains the observed refusal and bounds an unanswered request without retrying an
unknown result. This replaces the duplicate five-second helpers.
A monitoring request that times out is retried within the same metadata deadline.
Other monitoring errors still fail immediately. Expiry includes the last request
error and preserves any earlier metadata report.
Every clustered bootstrap test completes the existing real create/delete
preparation before replacing replies or clocks. It still asserts zero streams
before provisioning. Every existing product and cluster assertion remains.

Failing-first evidence:

- `ca2fc9c38`: both metadata regressions failed against health-only readiness.
- `a74e9d269`: persistent placement failed without the required observed refusal.
- `d6f16b0b0`: the follower-report regression failed before reading the leader.
- `04b3aff24`: an unanswered request did not fail at the fixture deadline.
- `d9597f4a3`: a monitoring timeout failed early and lost the previous metadata report.

The failing-test commit references above name the rebased commits; their test code
is unchanged. Raw failing-first logs are `.tools/metadata-red.log`, `.tools/placement-red.log`,
`.tools/metadata-follower-red.log` and `.tools/placement-request-red.log`.
PARTIAL: a preliminary real run was interrupted after the new check incorrectly required
current flags from followers. Its failed setup prompted the follower regression.
Another preliminary run loaded the unanswered-request regression before its fix:
FAIL, 75/76 tests. A subsequent preliminary run passed all 76 tests.
These are separate from the final numbered series. Their logs are
`.tools/metadata-real.log`, `.tools/changed-1.log` and `.tools/changed-2.log`.

Both final focused regression runs passed 15/15 tests.
They used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The PostgreSQL fixture creates and drops its own disposable databases.
No owner service or Docker setting was changed.

The final loaded series uses two parallel Vitest workers, alongside one repeating
companion suite, with both processes restricted to CPUs 0 and 1. All checks and
tests run under `nice -n 10`. Each target must pass 78 tests in seven files.
The companion checks 701 tests in 33 files and excludes security-rules, as in the
previous series. Raw logs and JSON reports stay in `.tools/loaded-final-runs/`.

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  taskset -c 0,1 nice -n 10 node node_modules/vitest/vitest.mjs run \
  infra/package/bootstrap.test.ts libs/event-store/test/cluster \
  libs/event-store/test/route-readiness.test.ts \
  libs/event-store/test/metadata-readiness.test.ts \
  --maxWorkers=2 --fileParallelism --reporter=default --reporter=json \
  --outputFile.json=.tools/loaded-final-runs/run-N.json
```

The companion command is the same as the earlier series, with `taskset -c 0,1`
before `nice -n 10`. Every numbered run and every companion failure is retained.

### Loaded series before the monitoring timeout fix

Source `452b83a2e`. These results are retained in
`.tools/loaded-before-monitoring-fix/`. Run 2 failed while the fixture fetched
`/healthz`, before product bootstrap started. It received a request TimeoutError
before the metadata deadline. Test commit `9f552343c` reproduced both the early
failure and the lost previous report. Fix `a73249d0b` keeps timeout retries inside
the same 20-second deadline. The runner stopped after run 3 wrote its report;
all test processes finished normally. No numbered failure was retried.

| Run | Target | Tests passed | Seconds | Companion suites |
| ---: | --- | ---: | ---: | --- |
| 1 | PASS | 76/76 | 201.37 | PASS, 7 |
| 2 | FAIL | 75/76 | 188.10 | PASS, 6 |
| 3 | PASS | 76/76 | 186.99 | PASS, 7 |

Run 3's seconds come from Vitest because the runner stopped before writing that row.
Raw failing-first timeout output is `.tools/metadata-timeout-red.log`.

### Final loaded series

PASS: all 30 numbered runs passed 78/78 tests, with no failed or skipped tests.
All 267 companion suites passed (187167 tests).
No failed numbered run was retried. Runs 1–21 used `a73249d0b`; runs 22–30 used
`fa24a7056`, after rebasing onto the newer fetched main at the boundary after run 21.
All apps, libraries, NATS settings and selected bootstrap sources are unchanged
across that rebase. Full lint and typecheck ran again on the rebased tree.
Both commands used the supplied PG_TEST_URL, `nice -n 10` and CPUs 0 and 1.

| Run | Target | Tests passed | Seconds | Companion suites |
| ---: | --- | ---: | ---: | --- |
| 1 | PASS | 78/78 | 173.21 | PASS, 8 |
| 2 | PASS | 78/78 | 157.13 | PASS, 9 |
| 3 | PASS | 78/78 | 169.12 | PASS, 9 |
| 4 | PASS | 78/78 | 173.55 | PASS, 10 |
| 5 | PASS | 78/78 | 161.89 | PASS, 9 |
| 6 | PASS | 78/78 | 173.39 | PASS, 10 |
| 7 | PASS | 78/78 | 177.70 | PASS, 10 |
| 8 | PASS | 78/78 | 173.94 | PASS, 9 |
| 9 | PASS | 78/78 | 172.65 | PASS, 9 |
| 10 | PASS | 78/78 | 181.13 | PASS, 10 |
| 11 | PASS | 78/78 | 168.10 | PASS, 9 |
| 12 | PASS | 78/78 | 155.91 | PASS, 9 |
| 13 | PASS | 78/78 | 146.44 | PASS, 8 |
| 14 | PASS | 78/78 | 172.25 | PASS, 10 |
| 15 | PASS | 78/78 | 158.26 | PASS, 8 |
| 16 | PASS | 78/78 | 157.96 | PASS, 8 |
| 17 | PASS | 78/78 | 168.90 | PASS, 8 |
| 18 | PASS | 78/78 | 159.94 | PASS, 8 |
| 19 | PASS | 78/78 | 179.39 | PASS, 9 |
| 20 | PASS | 78/78 | 160.65 | PASS, 9 |
| 21 | PASS | 78/78 | 156.60 | PASS, 9 |
| 22 | PASS | 78/78 | 174.92 | PASS, 9 |
| 23 | PASS | 78/78 | 175.07 | PASS, 10 |
| 24 | PASS | 78/78 | 154.13 | PASS, 7 |
| 25 | PASS | 78/78 | 182.28 | PASS, 8 |
| 26 | PASS | 78/78 | 184.18 | PASS, 10 |
| 27 | PASS | 78/78 | 166.26 | PASS, 9 |
| 28 | PASS | 78/78 | 164.32 | PASS, 9 |
| 29 | PASS | 78/78 | 171.97 | PASS, 8 |
| 30 | PASS | 78/78 | 166.57 | PASS, 9 |

### Checks after the final rebase

After run 30, main had advanced to `236ffd2c9774074fb861e365ef2880736864ff01`.
The branch was fetched and rebased again. Both rebase state directories are absent,
and that fetched main revision is an ancestor. The final code source is `ad71658a7`.
The libraries, NATS settings, selected test files, bootstrap files and owner bootstrap
entry point are unchanged from the 30-run series. Main's Vitest change only adds
an unrelated backup-capture test to the include list; the selected files stay the same.
Additional checks of this final tree are recorded separately below.

PASS: both additional selected runs passed 78/78 tests under the same two-CPU load.
All 17 companion suites passed. These runs are additional checks after the final
rebase; they do not replace any of the 30 numbered qualification runs above.
Raw logs and JSON reports are in `.tools/after-final-rebase/`.

| Additional run | Target | Tests passed | Seconds | Companion suites |
| ---: | --- | ---: | ---: | --- |
| 1 | PASS | 78/78 | 176.67 | PASS, 9 |
| 2 | PASS | 78/78 | 172.12 | PASS, 8 |

### Follow-up checks

| Check | Result |
| --- | --- |
| Rebase onto fetched origin/main, with completed state checked | PASS |
| Full lint and final affected-file lint | PASS |
| Full typecheck and final affected-package typechecks | PASS |
| check:events | PASS, 156 event types |
| Knip | PASS |
| lint:changelog | PASS |
| Final focused regressions, twice | PASS, 15/15 each |
| Final loaded bootstrap and cluster series | PASS, 30/30 runs, 78/78 tests each |
| Companion suites | PASS, 267 in qualification and 17 after the final rebase |
| Full root suite and live fresh-install journeys | NOT RUN, outside this change |

Final focused logs are `.tools/final-timeout-focused-1.log` and
`.tools/final-timeout-focused-2.log`. Full check logs include `.tools/lint-final-base.log`,
`.tools/typecheck-final-base.log` and `.tools/docs-rebased-final.log`.
The final documentation commit changes only the receipt and the package test notes.
