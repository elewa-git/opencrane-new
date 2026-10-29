# Routine Stop deadline rounding

Part of #576. Started from `2ec78b82c2998d246f1d02b67b4361183b8bf4ba`.
The test-first commit is `2bda56602`; the corrected test is `ff4a7ee8e`.
Date: 29 October 2026. These are local fixture checks, not a fresh installation.
Raw logs remain in `/tmp/ci-flakes-26-evidence/`.

## Cause and correction

The test advances `performance.now()` by three seconds while reading routine history.
The product then starts a fresh two-second write check. The history limit is ten seconds.
There is no real three-second sleep and no shared deadline to extend.

The old append callback subtracts the clock from the write deadline and requires a
result at most 2000. With a fractional clock, adding 2000 and subtracting the original
value can return 2000.0000000000146. Its assertion throws before calling the real append.
The Stop command catches that assertion and returns `Routine Stop unavailable`.

Starting the test clock at 128000.004 ms reproduces this exact outward failure.
History advances it to 131000.004 ms. Adding the write limit crosses the floating-point
precision boundary at 131072 ms. The test-first run fails its existing resolves assertion.
The original CI logs hide the inner exception; this local reproduction establishes a
cause of the same failure, rather than exposing the original CI exception.

The corrected callback compares the absolute deadline with `clock + 2000` exactly.
It permits no extra time. Both successful slow-history cases also check the saved owner
Stop and require further routine preparation to be refused. The expiry, removed-member
and changed-owner cases remain. No product code, access check, deadline, event or
runtime dependency changes.

## Own checks

All tests, lint and typecheck use `nice -n 10`. This worktree has its own `npm ci`
installation. NATS and Lychee are symlinks to the existing pinned tools.
The full-file tests use their own NATS and OpenFGA fixtures and disposable databases
in a throwaway PostgreSQL 17.6 container through `PG_TEST_URL`.
The event security run uses the supplied PostgreSQL URL at port 55432.
No owner stack or Docker daemon setting was changed.

- Expected FAIL: the test-first fractional-clock case, with `Routine Stop unavailable`.
- PASS: the corrected five-case deadline group, including saved Stop and blocked preparation.
- PASS: all 460 unchanged event security cases.
- PASS: full lint, typecheck, event catalogue, Knip and changelog validation. Full
  ESLint reports 34 warnings and no errors. A final lint of the changed test also passes.
- FAIL: the thirty-run stress batch, due to the setup timeout in run 28. Both complete-file
  passes failed in unchanged cases: 16 failures in pass 1 and 10 in pass 2.
- PASS for diagnosis only: one replay case and a separate five-case root group. These
  additional checks do not clear the failed complete-file passes.
- PARTIAL: an exploratory full-file baseline was stopped after the deterministic cause
  was found, to leave resources for the corrected full-file runs. It is not a passing check.
- NOT RUN: full root suite and fresh-install journeys.

## Original slow case under load

The first 17 counted runs keep the original slow-case assertion. The remaining 13 load the original
source through a temporary local Vitest transform, so later test edits cannot change
that comparison. Other test processes supply load. All thirty passed; no uncontrolled
failure was observed. Additional diagnostic and exploratory runs are not counted here.

| Run | Result | Wall time |
| --- | --- | --- |
| 01 | PASS | 21.7s |
| 02 | PASS | 17.1s |
| 03 | PASS | 19.3s |
| 04 | PASS | 24.7s |
| 05 | PASS | 21.6s |
| 06 | PASS | 22.6s |
| 07 | PASS | 22.2s |
| 08 | PASS | 21.3s |
| 09 | PASS | 26.9s |
| 10 | PASS | 28.9s |
| 11 | PASS | 30.1s |
| 12 | PASS | 26.2s |
| 13 | PASS | 37.2s |
| 14 | PASS | 33.9s |
| 15 | PASS | 36.1s |
| 16 | PASS | 40.0s |
| 17 | PASS | 33.4s |
| 18 | PASS | 48.0s |
| 19 | PASS | 24.6s |
| 20 | PASS | 23.8s |
| 21 | PASS | 24.8s |
| 22 | PASS | 19.3s |
| 23 | PASS | 23.8s |
| 24 | PASS | 22.2s |
| 25 | PASS | 26.9s |
| 26 | PASS | 24.7s |
| 27 | PASS | 21.3s |
| 28 | PASS | 21.7s |
| 29 | PASS | 21.7s |
| 30 | PASS | 23.7s |

## Corrected Stop deadline cases under load

Each repetition runs all five Stop deadline cases in a fresh Vitest process with one
worker. Two complete-file passes run alongside the stress loop. They each cover all
383 cases and supply load. File-system transform caching avoids repeating module
transforms; test setup and all service fixtures still run for every case. No failed
repetition is retried or counted as passing. The tables distinguish focused runs from
complete-file passes; thirty complete-file passes were not run.

```sh
PG_TEST_URL="$DISPOSABLE_PG_TEST_URL" nice -n 10 node node_modules/vitest/vitest.mjs run \
  apps/server/test/routine-session.test.ts --maxWorkers=1 --reporter=verbose \
  --experimental.fsModuleCache \
  -t 'owner Stop reads history before its bounded write check'
```

The loop completed: 29 runs passed, and run 28 failed during fixture setup for the
`member` case. OpenFGA timed out after 1000 ms while applying the initial permissions;
the case body did not run. The other four cases in that repetition passed.
Both `slow` and `fractional-clock` passed in all thirty repetitions. Overall this
batch remains FAIL: 149 cases passed and one fixture setup failed. No retry was made.

| Run | Result | Wall time | Overlapping full-file passes |
| --- | --- | --- | --- |
| 01 | PASS | 43.1s | 1, 2 |
| 02 | PASS | 36.2s | 1, 2 |
| 03 | PASS | 33.1s | 1, 2 |
| 04 | PASS | 34.7s | 1, 2 |
| 05 | PASS | 28.9s | 1, 2 |
| 06 | PASS | 29.1s | 1, 2 |
| 07 | PASS | 29.0s | 1, 2 |
| 08 | PASS | 31.2s | 1, 2 |
| 09 | PASS | 30.3s | 1, 2 |
| 10 | PASS | 35.1s | 1, 2 |
| 11 | PASS | 32.9s | 1, 2 |
| 12 | PASS | 34.3s | 1, 2 |
| 13 | PASS | 26.8s | 1, 2 |
| 14 | PASS | 24.5s | 1, 2 |
| 15 | PASS | 29.4s | 1, 2 |
| 16 | PASS | 27.5s | 1, 2 |
| 17 | PASS | 30.3s | 1, 2 |
| 18 | PASS | 25.9s | 1, 2 |
| 19 | PASS | 35.5s | 1, 2 |
| 20 | PASS | 35.5s | 1, 2 |
| 21 | PASS | 28.8s | 1, 2 |
| 22 | PASS | 26.8s | 1, 2 |
| 23 | PASS | 29.7s | 1, 2 |
| 24 | PASS | 25.4s | 1, 2 |
| 25 | PASS | 25.6s | 1, 2 |
| 26 | PASS | 24.9s | 1, 2 |
| 27 | PASS | 27.2s | 1, 2 |
| 28 | FAIL | 26.9s | 1, 2 |
| 29 | PASS | 24.0s | 1, 2 |
| 30 | PASS | 29.4s | 1, 2 |

The two complete-file passes each finished all 383 cases. Both reported failures
in unchanged cases, including an OpenFGA 1000 ms timeout and routine input/root refusals. The opaque refusals do not expose their inner causes.
They remain FAIL; no assertion or product limit was relaxed to clear them.

| Complete-file pass | Result | Passed | Failed | Wall time |
| --- | --- | --- | --- | --- |
| 1 | FAIL | 367 | 16 | 2099.7s |
| 2 | FAIL | 373 | 10 | 2106.7s |

Their command is the stress command above without `-t`. Each complete-file process
exited with status 1. These were not retried. The queued extra complete-file runs
were discarded without starting; thirty complete-file repetitions are NOT RUN.
The throwaway PostgreSQL container and its volume were removed afterwards.

The change fixes the deterministic rounding failure. Overall local test validation
remains FAIL because of the fixture timeout and the failed complete-file passes.
This branch is not source-ready.
