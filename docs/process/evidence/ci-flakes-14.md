# Spending Stop retries and approval settlement

Part of #576. The work starts at `955cfedca6466d27b14f07b82be46d4ebf3a7523`.

## Cause

The extra Stop is legitimate product behaviour. `sendBudgetStops` records the last
send time for each turn. It permits the same saved Stop again after 1,000 ms because
sending a frame does not prove the computer stopped. The approval reader also uses
this sender before waking a waiting call. Under load, delayed computer and approval
history can cross that interval between ordinary polling and settlement.

The old test assumed exactly one Stop. The failing-first commit `01c164d8a`
holds approval history until the first Stop arrives, then advances the monotonic
clock by one second. Real timers still run normally. The unchanged sender delivers
two identical Stops before one cancellation, and the old assertion fails.
One unmodified baseline attempt passed; the deterministic case reproduces the
failure independently of the machine's speed. Logs are in `/tmp/ci-flakes-14/`.

## Contract checked

The delay matrix still checks all four combinations of 0 and 300 ms. Stop must
come before the only settlement reply. Every repeat must have the same full payload.
No different command may arrive for the stopped chat. The approval must have one saved cancellation.
Two later watcher polls check that settlement is not sent again. The forced retry
case also requires at least two Stops; no sleep was added to reach the retry interval.

The real computer-channel case repeats the exact Stop. It checks that the same
turn is interrupted again without another grant, the other turn keeps its tool
list and can renew and finish, and only one Stop request is saved.
No sender, access check, deadline, event schema or dependency changes.
The separate finished-chat test is unchanged.

## Own checks

All commands ran under `nice -n 10`. Tests used a private PostgreSQL 17.6
container through `PG_TEST_URL`, plus their own NATS and OpenFGA fixtures.
The private PostgreSQL container and its volume were removed after the tests.

- Expected FAIL: the test-first commit produces two identical Stops before settlement.
- FAIL during implementation: the first broader assertion also rejected a legitimate
  turn for Bob. The focused pass failed 3 cases; the first full batch failed 5.
  The assertion now checks the stopped chat and every Stop or settlement frame.
- PASS: the corrected focused pass, 6/6 tests.
- PASS: both changed files in full, twice, 59/59 tests in each pass.
- PASS: all 438 unchanged event security tests in the first full batch.
- PASS: typecheck, full lint, Knip, event catalogue and changelog validation.
  ESLint reported 25 warnings in unchanged production code and no errors.
- PASS: the unchanged finished-chat case in both corrected full passes.
- NOT RUN: full root suite and fresh-install journeys.

No production code, test deadline or access check changed. No failed load run
was retried. Raw logs and JSON reports remain in `/tmp/ci-flakes-14/`.

## Thirty load runs

Each row is a fresh Vitest process with two workers and default file parallelism.
It runs both changed files, selecting all four delay combinations, the forced
retry and the real computer-channel case: six tests per run, 180/180 passed.
A separate process supplies load throughout. Its first two runs check both
changed files in full; later runs check all 38 approval tests.

```sh
nice -n 10 npx vitest run apps/server/test/bridge-replay.test.ts \
  apps/server/test/bridge-budget-stop.test.ts --maxWorkers=2 \
  -t 'sends Stop before approval wake|retries the same Stop|interrupts only the stopped payer'
```

The table lists every target run and the companion runs that overlap it.
All 23 companions passed. Runs 1 and 2 each passed 59 tests; runs 3–23 each
passed 38 tests. The last companion finished before this record was written.

| Run | Result | Wall time (s) | Overlapping companions |
| --- | --- | --- | --- |
| 01 | PASS (6/6) | 48.45 | 1 |
| 02 | PASS (6/6) | 49.61 | 1 |
| 03 | PASS (6/6) | 41.32 | 1 |
| 04 | PASS (6/6) | 39.81 | 1, 2 |
| 05 | PASS (6/6) | 41.18 | 2 |
| 06 | PASS (6/6) | 37.27 | 2 |
| 07 | PASS (6/6) | 33.87 | 2 |
| 08 | PASS (6/6) | 34.99 | 2, 3 |
| 09 | PASS (6/6) | 37.81 | 3, 4 |
| 10 | PASS (6/6) | 39.23 | 4, 5 |
| 11 | PASS (6/6) | 33.88 | 5, 6 |
| 12 | PASS (6/6) | 37.69 | 6, 7 |
| 13 | PASS (6/6) | 30.37 | 7, 8 |
| 14 | PASS (6/6) | 29.48 | 8, 9 |
| 15 | PASS (6/6) | 30.63 | 9, 10 |
| 16 | PASS (6/6) | 26.72 | 10, 11 |
| 17 | PASS (6/6) | 27.21 | 11, 12 |
| 18 | PASS (6/6) | 30.05 | 12 |
| 19 | PASS (6/6) | 33.06 | 12, 13 |
| 20 | PASS (6/6) | 36.95 | 13, 14 |
| 21 | PASS (6/6) | 45.64 | 14, 15 |
| 22 | PASS (6/6) | 44.38 | 15, 16 |
| 23 | PASS (6/6) | 36.35 | 16, 17 |
| 24 | PASS (6/6) | 32.05 | 17, 18 |
| 25 | PASS (6/6) | 36.66 | 18, 19 |
| 26 | PASS (6/6) | 37.01 | 19, 20 |
| 27 | PASS (6/6) | 39.34 | 20 |
| 28 | PASS (6/6) | 39.67 | 20, 21 |
| 29 | PASS (6/6) | 38.26 | 21, 22 |
| 30 | PASS (6/6) | 40.10 | 22, 23 |

| Companion | Result | Wall time (s) |
| --- | --- | --- |
| 1 | PASS (59/59) | 165.57 |
| 2 | PASS (59/59) | 133.59 |
| 3 | PASS (38/38) | 42.02 |
| 4 | PASS (38/38) | 40.92 |
| 5 | PASS (38/38) | 41.18 |
| 6 | PASS (38/38) | 37.37 |
| 7 | PASS (38/38) | 36.67 |
| 8 | PASS (38/38) | 31.88 |
| 9 | PASS (38/38) | 32.82 |
| 10 | PASS (38/38) | 28.34 |
| 11 | PASS (38/38) | 28.29 |
| 12 | PASS (38/38) | 33.08 |
| 13 | PASS (38/38) | 35.24 |
| 14 | PASS (38/38) | 45.31 |
| 15 | PASS (38/38) | 50.56 |
| 16 | PASS (38/38) | 50.14 |
| 17 | PASS (38/38) | 30.73 |
| 18 | PASS (38/38) | 41.87 |
| 19 | PASS (38/38) | 42.79 |
| 20 | PASS (38/38) | 45.60 |
| 21 | PASS (38/38) | 42.54 |
| 22 | PASS (38/38) | 44.49 |
| 23 | PASS (38/38) | 41.75 |

## Whole-history assertion correction

Rebased onto `52ffc36d1`. The rebase completed. The README.robot.md conflict
kept both the member-review documentation from main and this branch's Stop checks.
The test correction is committed as `87e0ba171`. Production code is unchanged.

The previous `received.slice(beforeStop)` discarded early Stop and settlement
frames. The filter now reads the whole captured history. Every Stop must match
Alice's saved Stop exactly, and there must be exactly one cancelled settlement.
Only checks for Alice's other commands use the later-frame boundary.

Expected FAIL: temporarily inserted a Stop for Bob at the start of the captured
history, before `beforeStop`, while retaining the normal expected Stop and
settlement. The zero-delay test failed at the first-command assertion: it expected
Alice's saved Stop and received Bob's incorrect Stop. Restored the mutation before
all successful runs. Log: `/tmp/ci-flakes-14-fix/mutation.log`.

Own checks after the correction:

- PASS: full lint, typecheck, check:events, Knip and lint:changelog.
- PASS: both changed files in full twice, 59/59 tests in each run.
- PASS: 30 fresh-process load runs, six selected cases each, 180/180 tests.
- NOT RUN: full root suite, live journeys and CI on the pushed commit.

All checks ran under `nice -n 10`. Tests used the supplied
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and their own
NATS and OpenFGA fixtures. No owner service was changed. Each target run used
the same command listed above and overlapped a separate test run. Logs and JSON
reports are in `/tmp/ci-flakes-14-fix/`. No target run was retried.

### Every corrected load run

| Run | Result | Tests passed | Wall time (s) |
| --- | --- | --- | --- |
| 01 | PASS | 6/6 | 31.17 |
| 02 | PASS | 6/6 | 33.39 |
| 03 | PASS | 6/6 | 39.16 |
| 04 | PASS | 6/6 | 37.66 |
| 05 | PASS | 6/6 | 40.78 |
| 06 | PASS | 6/6 | 38.48 |
| 07 | PASS | 6/6 | 36.15 |
| 08 | PASS | 6/6 | 35.27 |
| 09 | PASS | 6/6 | 40.36 |
| 10 | PASS | 6/6 | 44.64 |
| 11 | PASS | 6/6 | 39.72 |
| 12 | PASS | 6/6 | 36.75 |
| 13 | PASS | 6/6 | 35.22 |
| 14 | PASS | 6/6 | 32.76 |
| 15 | PASS | 6/6 | 29.45 |
| 16 | PASS | 6/6 | 25.96 |
| 17 | PASS | 6/6 | 25.34 |
| 18 | PASS | 6/6 | 25.59 |
| 19 | PASS | 6/6 | 29.61 |
| 20 | PASS | 6/6 | 30.36 |
| 21 | PASS | 6/6 | 32.14 |
| 22 | PASS | 6/6 | 26.88 |
| 23 | PASS | 6/6 | 24.08 |
| 24 | PASS | 6/6 | 23.47 |
| 25 | PASS | 6/6 | 23.79 |
| 26 | PASS | 6/6 | 24.75 |
| 27 | PASS | 6/6 | 24.91 |
| 28 | PASS | 6/6 | 23.61 |
| 29 | PASS | 6/6 | 25.25 |
| 30 | PASS | 6/6 | 23.39 |

### Corrected-run companions

Companions 01 and 02 ran both changed files in full. Companions 03–05 ran
`apps/server/test/approvals.test.ts`. Each approvals run skipped its browser-only
case. Companion 03 failed setup because the pinned gateway binary was missing.
Companion 04 started before the download finished: one test found no binary and
one rejected the incomplete binary's digest. Another unchanged approval-date case
hit its existing 40-second timeout. These failures are retained below. No timeout
or assertion changed. `npm run pretest` fetched and verified the pinned tools;
companion 05 then passed all 74 runnable approvals cases, including the date case.
The final companion completed before this record was written.

| Companion | Result | Passed | Failed | Wall time (s) |
| --- | --- | --- | --- | --- |
| 01 | PASS | 59 | 0 | 129.59 |
| 02 | PASS | 59 | 0 | 134.85 |
| 03 | FAIL | 0 | 74 | 122.86 |
| 04 | FAIL | 71 | 3 | 452.87 |
| 05 | PASS | 74 | 0 | 352.89 |
