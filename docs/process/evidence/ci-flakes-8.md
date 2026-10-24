# Server flake investigation

## Security correction on 24 October 2026

The tool timing change was a regression, not an existing flake. This section
supersedes the earlier claim that restarting the tool access clock fixed approval
retries. The earlier passing checks below do not qualify the corrected source.

[CI run 40084170182](https://github.com/elewa-git/opencrane-new/actions/runs/40084170182)
failed on `d0da07b9a`. After fetching and completing the rebase, the comparison used
main `2b032bc0142f1f89d4fd564bad13bfd0d93ff504` and the unchanged executable code
on rebased branch `9e2d2b574c9be254078ee8c6fee24bcd3118e9dd`.

## Security repeat comparison

Each row is a separate full invocation of `libs/models/test/decision-fence.test.ts`.
Every main run passed all 75 tests. Every branch run failed exactly these two tests:

- `mcp refuses when history and access exceed the shared two-second budget`:
  received 200 `policy_allow` instead of 403.
- `mcp gateway timeout leaves no reservation or uncertain hold`:
  received a completed tool response with HTTP 200 instead of 503.

| Run | Main | Uncorrected branch |
| --- | --- | --- |
| 1 | PASS: 75/75 | FAIL: 73/75 |
| 2 | PASS: 75/75 | FAIL: 73/75 |
| 3 | PASS: 75/75 | FAIL: 73/75 |
| 4 | PASS: 75/75 | FAIL: 73/75 |
| 5 | PASS: 75/75 | FAIL: 73/75 |
| 6 | PASS: 75/75 | FAIL: 73/75 |
| 7 | PASS: 75/75 | FAIL: 73/75 |
| 8 | PASS: 75/75 | FAIL: 73/75 |
| 9 | PASS: 75/75 | FAIL: 73/75 |
| 10 | PASS: 75/75 | FAIL: 73/75 |

All twenty runs used `nice -n 10 npm test -- libs/models/test/decision-fence.test.ts
--maxWorkers=1 --no-file-parallelism`, with JSON reporting to separate files.
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` supplied the requested
test database service. Fixtures created private databases, NATS, OpenFGA and gateway
processes. No failed run was retried. The owner stack was untouched.
Reports and logs are `/tmp/ci-flakes-8-security/main-{1..10}.{json,log}` and
`/tmp/ci-flakes-8-security/branch-{1..10}.{json,log}`.

## Cause and correction

Passing every MCP route as `historyFirst` gave ordinary tools ten seconds for
history, then restarted the two-second access clock. Changing the gateway wait to
twelve seconds also let these late calls reach the tool. These were real changes
to the request budget, not just a different order of reads.

The correction restores main's deadline selection and the ordinary gateway's
two-second timeout. Full conversation history still loads before the access
snapshot; it is never added to the small access streams being watched. Managed-model
and memory preparation keep their existing deadlines and checks. Memory keeps its
fifteen-second gateway wait. The configuration-probe observation filter remains.
The only production difference from the compared main is that filter.

## Security failing-first proof

Test commit `fd3de00d8` replaces the incorrect expectation that a tool call should
succeed after 2,100 ms of history. It keeps a normal successful call, including the
exact request bytes and one remote call. It adds two refused cases: 2,100 ms of
history, and 1,900 ms of history plus 200 ms of access. Both require 403, a saved
refusal, no remote connection and no reservation. All three check that full history
loads before access reads. Real service timers keep running; the test controls the
monotonic decision clock.

Expected FAIL before the production correction: the normal case passed and both
over-budget cases returned 200 instead of 403. The report is
`/tmp/ci-flakes-8-security/red-final.json`. Earlier clock-test attempts are retained
as `red.json` and `red-controlled.json`; each exposed only the history-only case.
The existing `decision-fence.test.ts` and all its assertions are unchanged.

## Corrected-source verification

NOT RUN at the correction commit: the two affected-file passes and static gates.
The completed results will be recorded after those checks finish.

## Earlier investigation

The following records describe the earlier proposal and its checks. Its separate
tool-history budget and its approval-retry conclusion are superseded above.

## Source and setup

Baseline: `e3a97a8881e5dfd2d8f0f8701e751215f27a3b74`, the fetched `origin/main`
when this worktree was created. All three tests ran ten times on that unchanged
source. Each invocation used `nice -n 10`, one worker and its own Vitest process.
No failed run was retried.

Earlier checked source was based on main `f016778fcf0bfc4ed3dd50e469a9729a072f5912` after rebasing.
The worktree used Node 22.23.3, `npm ci` and links to the shared pinned NATS and
Lychee binaries. Fixtures used private NATS, OpenFGA and gateways, plus disposable
databases in `pgtest-ci-flakes-8`. PostgreSQL used port 59861 before rebasing and
60248 afterwards. Each throwaway container was removed with its volume after its
checks. The owner stack was untouched.

## Every baseline result

| Run | Managed model | Saved memory correction | Approval retry |
| --- | --- | --- | --- |
| 1 | PASS (25.06s) | PASS (34.04s) | PASS (35.44s) |
| 2 | FAIL (25.40s) | PASS (36.80s) | PASS (38.87s) |
| 3 | FAIL (20.75s) | PASS (30.08s) | PASS (34.89s) |
| 4 | FAIL (26.79s) | PASS (50.54s) | PASS (34.31s) |
| 5 | PASS (23.18s) | PASS (24.28s) | PASS (30.71s) |
| 6 | PASS (32.28s) | PASS (27.68s) | PASS (43.53s) |
| 7 | PASS (40.86s) | PASS (44.33s) | FAIL (46.26s) |
| 8 | PASS (52.04s) | PASS (47.34s) | FAIL (47.66s) |
| 9 | PASS (35.27s) | PASS (47.04s) | PASS (45.41s) |
| 10 | PASS (40.48s) | PASS (53.98s) | FAIL (66.48s) |

Managed-model failures returned 503 instead of 200. Approval-retry failures
returned two 403 replies instead of one 200 and one 403. Both failures therefore
occur on main. The saved memory correction passed all ten runs and is unchanged.

## Causes and failing-first checks

The gateway logs requests to its private configuration probe. The usage reader
treated those as calls with missing observations and saved random
`gateway.observation_recorded` events. A diagnostic found one before any provider
request. Another captured `budget.reserved` returning conflict while the budget
stream itself stayed at position 41. These extra writes can change the global
event position checked when saving a reservation and stop that budget writer.
The reader now ignores the exact logged `default/configuration` route.

Expected FAIL: test commit `751cbe14a` checks configuration responses with HTTP
200, 401 and 403. All three cases failed before the corrected filter.

The approval retry could run out of access time at dispatch. MCP decisions read
conversation history while counting from the request start. They now wait for
history before starting the two-second access check, as managed model calls do.
History has ten seconds; ordinary MCP routes allow twelve seconds at the gateway.
Current IAM checks and final sends keep the original two-second access deadline.

Expected FAIL: test commit `7829144ce` advances the monotonic clock by 2,100 ms
when conversation history finishes. The old decision returns 403; the corrected
ordering allows one tool call. The regression adds no sleep. Authority and
authority-volume tests are unchanged.

## Earlier verification failures

An initial filter used the listener name `control/configuration`, which did not
match real logs. The pinned gateway records the route as `default/configuration`.
The trace exposed the mistake, and the regression was corrected before the filter.
That early complete run passed 464 tests but returned 403 in managed-model. The
next serial run passed 72 tests but the managed connection closed. A trace then
reproduced the closure with a refusal after 837 ms while configuration probes
still created missing-observation records. Those runs remain FAIL.

Another early attempt only separated concurrent replies from evidence reads.
Approval retry still returned two 403 replies. That attempt was removed.

After correcting the route filter, the five affected files passed 73 tests twice,
and both target tests passed thirty repeats. Main then advanced during the work.
Those earlier results are retained in their logs; the final results below are
from the combined source after rebasing.

## Rebase and memory preservation

Main’s memory-preparation change touched both decision ordering and gateway
timeouts. The resolution keeps its preparation, current IAM checks and existing
fifteen-second memory gateway allowance. Other MCP routes use the separate history
wait and twelve-second gateway allowance.

The two regressions were rerun against the rebased code before the fixes: all four
cases failed as expected. `/tmp/ci-flakes-8-rebased-red.json` records those results.

## Own earlier checks

- PASS: six affected files twice, with 148 tests in each pass: `models-managed`,
  `integration-access-gateway`, `gateway-start`, `decision-activity`,
  `gateway-renderer` and `memory-context`.
- PASS: five focused memory checks for preparation before access and the original
  access deadline, from `memory-mcp` and `memory-dispatch`.
- PASS: all 438 unchanged event security tests, once on the combined source.
- PASS: full lint, full root typecheck, event catalogue, Knip and changelog validation.
  Lint reported 26 function-length warnings and no errors.
- PASS: thirty repeats of each reproduced flake, with no failures or retries.
- NOT RUN: the full root test suite and fresh-install journeys.

Every command used `nice -n 10`. Tests used one worker and
`PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:60248/postgres`.
Final test commands used `--maxWorkers=1 --no-file-parallelism --fsModuleCache`.
The transform cache changes compilation work, not test retries or fixtures.

The repeat command used the exact two test-name filter and `--repeats=29`.
Vitest runs each target thirty times regardless of its result. Each repeat creates
private NATS, databases, a gateway and an OpenFGA store; each file shares its
OpenFGA process, as its ordinary fixture does. A temporary setup hook recorded
each result after test cleanup. The aggregate result also passed. Every repeat
kept the original HTTP, provider-count, approval-use and budget assertions.

## Every final repeat

| Repeat | Managed model | Approval retry |
| --- | --- | --- |
| 1 | PASS (13.70s) | PASS (11.02s) |
| 2 | PASS (9.87s) | PASS (10.99s) |
| 3 | PASS (10.02s) | PASS (8.90s) |
| 4 | PASS (11.34s) | PASS (9.14s) |
| 5 | PASS (9.38s) | PASS (8.71s) |
| 6 | PASS (9.20s) | PASS (10.46s) |
| 7 | PASS (9.95s) | PASS (9.59s) |
| 8 | PASS (9.37s) | PASS (9.34s) |
| 9 | PASS (8.78s) | PASS (8.94s) |
| 10 | PASS (7.74s) | PASS (8.04s) |
| 11 | PASS (9.60s) | PASS (8.56s) |
| 12 | PASS (10.88s) | PASS (10.56s) |
| 13 | PASS (9.42s) | PASS (10.99s) |
| 14 | PASS (9.65s) | PASS (10.73s) |
| 15 | PASS (10.79s) | PASS (9.96s) |
| 16 | PASS (11.25s) | PASS (10.75s) |
| 17 | PASS (10.36s) | PASS (9.53s) |
| 18 | PASS (8.53s) | PASS (10.97s) |
| 19 | PASS (8.88s) | PASS (9.49s) |
| 20 | PASS (7.36s) | PASS (8.71s) |
| 21 | PASS (7.17s) | PASS (8.72s) |
| 22 | PASS (7.19s) | PASS (10.03s) |
| 23 | PASS (7.60s) | PASS (10.43s) |
| 24 | PASS (7.77s) | PASS (10.10s) |
| 25 | PASS (7.07s) | PASS (9.43s) |
| 26 | PASS (7.23s) | PASS (9.62s) |
| 27 | PASS (6.66s) | PASS (9.73s) |
| 28 | PASS (6.23s) | PASS (10.82s) |
| 29 | PASS (6.67s) | PASS (12.92s) |
| 30 | PASS (7.62s) | PASS (13.43s) |

## Commands and logs

Required static commands were `npm run lint`, `npm run typecheck`,
`npm run check:events`, `npm run lint:unused` and `npm run lint:changelog`.

Every baseline result is in `/tmp/ci-flakes-8-baseline/results.json`, alongside
its per-invocation reports and logs. The corrected-route failing-first log is
`/tmp/ci-flakes-8-actual-route-red.log`; the history failing-first log is
`/tmp/ci-flakes-8-history-red.log`. Fixed-label route traces use
`/tmp/ci-flakes-8-usage-trace-*.json`. They contain no credentials or request content.

Final combined-source reports use `/tmp/ci-flakes-8-rebased-` followed by:

- `final-changed-1.json` and `final-changed-2.json` for both full affected-file passes;
- `memory-preservation.json` and `security.json` for the focused checks;
- `repeats.ndjson` and `repeats.json` for every repeat and the aggregate result;
- `final-gates.json` for static check results and durations.

Earlier verification reports keep their original `/tmp/ci-flakes-8-` prefix.
The removed evidence-read attempt is `smoke.json`. The incorrect-filter rounds
are `changed-1.json` and `changed-2.json`. The passing rounds before rebasing are
`final-changed-1.json`, `final-changed-2.json` and `repeats.json`.
