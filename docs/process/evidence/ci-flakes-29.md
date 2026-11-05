# Invite acceptance and routine restart under load

Part of #576. Date: 5 November 2026. These are local fixture checks.
The full root suite and fresh-install journeys were NOT RUN.

## Causes and changes

Two requests can read the same pending invitation before either saves a join.
For an invitation bound to one account, the losing request returned `unavailable`
when its final access check saw the new join. The code re-read the member stream
only for email invitations at that point. The test-first commit `7f33f93d8`
held both requests at the check and failed with `joined` and `unavailable` for
both command variants. The server now re-reads the saved member stream for
either invitation kind. A matching retry gets `already_joined`; a different
command is refused. The conditional append still saves only one join.

The routine lost-reply test uses separate NATS connections for commands and
projection reads. Its restart helper waits for the command connection to
reconnect. A local run failed with `TimeoutError` in the second dispatch, after
the saved run had been read. The second dispatch starts with `runner.run` before
the leadership error wrapper, so this direct read timeout came from the
projection reader. The test now waits for that reader to answer before
dispatching again. It still compares the original occurrence, identifiers and
start deadline, and checks one saved run and one computer start.

## Setup and early runs

The worktree started at `origin/main` on `work/ci-flakes-29`. `npm ci` passed.
NATS and Lychee were symlinked from the owner's pinned tools. All test and
lint processes used `nice -n 10`. The two complete files ran together, each
with one Vitest worker. Each test owns its NATS and OpenFGA fixtures. Projection
tests used a throwaway PostgreSQL 17.6 container; it is removed with its volume
after the checks. The event security test used the supplied test database at
port 55432.

Before the changes, one paired complete-file run passed. A focused routine
loop failed on run 4 of 4 under a parallel join test run; its prior three runs
passed. Another two focused routine runs passed under full join-file load.
These exploratory runs are separate from the final complete-file batch below.

## Final complete-file runs

The raw logs are `/tmp/ci-flakes-29-{routine,member}-final-<run>.log` on the
shared development host. Each row is one fresh Vitest process for each file.
Both files ran together in every row, under `nice -n 10` with one worker each.
Every routine run passed 16 tests; every member run passed 104 tests.

| Run | Routine file | Member file | Paired wall time |
| --- | --- | --- | --- |
| 01 | PASS | PASS | 83s |
| 02 | PASS | PASS | 73s |
| 03 | PASS | PASS | 71s |
| 04 | PASS | PASS | 79s |
| 05 | PASS | PASS | 76s |
| 06 | PASS | PASS | 66s |
| 07 | PASS | PASS | 68s |
| 08 | PASS | PASS | 68s |
| 09 | PASS | PASS | 76s |
| 10 | PASS | PASS | 72s |
| 11 | PASS | PASS | 66s |
| 12 | PASS | PASS | 62s |
| 13 | PASS | PASS | 70s |
| 14 | PASS | PASS | 62s |
| 15 | PASS | PASS | 62s |
| 16 | PASS | PASS | 62s |
| 17 | PASS | PASS | 62s |
| 18 | PASS | PASS | 71s |
| 19 | PASS | PASS | 65s |
| 20 | PASS | PASS | 63s |
| 21 | PASS | PASS | 63s |
| 22 | PASS | PASS | 62s |
| 23 | PASS | PASS | 65s |
| 24 | PASS | PASS | 61s |
| 25 | PASS | PASS | 61s |
| 26 | PASS | PASS | 60s |
| 27 | PASS | PASS | 69s |
| 28 | PASS | PASS | 66s |
| 29 | PASS | PASS | 63s |
| 30 | PASS | PASS | 64s |

## Own checks

- PASS: the failing-first join test returned the expected failure before the
  server change, then passed after it.
- PASS: event security rules, 460 cases; typecheck; event catalogue agreement;
  Knip; changelog validation; full lint (zero errors, 37 warnings).
- PASS: 30 of 30 complete-file runs for each changed test file under paired load.
- FAIL then PASS: an initial typecheck found an unknown event type in the new
  test wrapper. The wrapper was corrected and the final typecheck passed.
- NOT RUN: full root suite and fresh-install journeys.
