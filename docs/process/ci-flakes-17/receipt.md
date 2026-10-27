# Cluster route readiness checks

Date: 27 October 2026. Part of #576.

## Source and environment

Base: `0ba702c6e3ed062e7ff812875f9de873d41da4b3`.
Failing-test commit: `9d342889b`.
Implementation: `65b5d2ad01c89083907012de8839aba7b3df983a`.
The final commit adds this receipt only.
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
