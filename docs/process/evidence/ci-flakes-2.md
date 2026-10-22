# CI flake checks

## Follow-up checks

Date: 22 October 2026. Source code: `ab5bb22ea674231af6a1f423167e70e09eb9301d`.
PASS: rebased onto `dd5b4c4d50350afcff8da26973f4d65ef4d523c7` and checked that the rebase finished.
Environment: Linux, Node 22.23.3, the development worktree, not a fresh installation.
Tests used the requested PostgreSQL service at `127.0.0.1:55432`, with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
Fixtures created their own databases, NATS and OpenFGA services and used the pinned gateway.
All suites and checks ran under `nice -n 10`.

### Findings and fixes

The gateway test now has named process, timer and stderr handlers, a named
parameterised test function and a named options object. Its assertions and timings are unchanged.

The admission failure came from the test fixture. It saved Allow, delayed the append reply
by 2.2 seconds and then failed the final access check. The decision service correctly returned
503 after the attempted audit. When cold grant history finished quickly, this happened on
the first warm-up; when it was slower, the old admission loop could pass over a later 503.
The request went directly to the decision service, without gateway forwarding.

The fixture now pauses the first cold grant read until the request is refused.
It requires 403, one saved Deny and zero reservations. It then waits directly for history
within the original two-minute catch-up budget. One successful warm-up precedes the
measured call. The measured call must still return 200 within two seconds, read zero
old grant rows, add exactly one reservation and make no provider request.
The separate saved-Allow timeout test still requires the unsent hold to settle at zero
without releasing an earlier hold. Production access, money and memory rules are unchanged.

### Failing first and corrected trials

PASS: test commit `1e05323ac` reproduced `503: Decision audit unavailable` where
the cold setup must return 403. The first natural cold trial passed; explicitly finishing
grant catch-up made the first request reach the injected Allow delay and fail reliably.
The fix followed in `3815a1b92`.

FAIL: the first broad round and a focused 15,000-edit run exposed a new 15-second
history wait that was shorter than the old catch-up budget. Commit `ab5bb22ea`
restored the original two-minute history budget. The measured two-second assertion stayed
unchanged. The focused case then passed in 49.96 seconds, measuring admission at 103 ms.
The load runs below were restarted after that correction.

FAIL: the later two-worker file round returned 403 in the test for grants
across nine models, while other tests and frontend builds were running. The reply
did not identify the underlying cause. That concurrency result remains a failure; the later
one-worker runs below do not qualify that extra load condition.

### Two passing runs of each affected file

PASS: each of the 11 affected files passed twice. The ten files outside decision-cost
passed in both broad rounds, with 190 tests per round. Their file contents and runtime
dependencies did not change between those rounds. Only the decision-cost fixture and
its documentation changed when restoring the history budget.
The first broad round used one worker; the second used two.
Both broad-round commands returned failure for the decision-cost cases described above.

The final decision-cost file then passed all 25 tests twice, in separate one-worker runs
after the other test commands had finished. The table uses these two passing runs
for decision-cost. The two-second assertions and all refusal, hold and provider checks
were unchanged. No test retry option was used.

Commands, start/end times and exit codes are in `changed-records.json`,
`final/changed-records.json` and `final/decision-records.json`.
Per-test results are in the matching `changed-1.json` and `final/decision-*.json` files.

| File | First run, seconds | Second run, seconds |
| --- | ---: | ---: |
| `libs/models/test/decision-cost.test.ts` | 217.05 | 282.71 |
| `libs/models/test/egress-admission.test.ts` | 379.86 | 463.76 |
| `libs/models/test/gateway-delivery.test.ts` | 131.25 | 174.94 |
| `libs/models/test/gateway-start.test.ts` | 3.96 | 2.48 |
| `libs/models/test/ports.test.ts` | 2.23 | 1.91 |
| `apps/computer/test/registry-forwarder.test.ts` | 3.05 | 2.12 |
| `apps/server/test/live-view-proxy.test.ts` | 90.14 | 151.21 |
| `apps/server/test/models-main.test.ts` | 79.60 | 110.63 |
| `apps/server/test/models-managed.test.ts` | 67.38 | 73.26 |
| `apps/server/test/providers.test.ts` | 122.58 | 87.99 |
| `apps/server/test/remote-catalogue-dispatch.test.ts` | 61.13 | 43.13 |

### Twenty final runs under load

PASS: 20 consecutive runs selected `3,000 model grants` from `decision-cost.test.ts`,
with `--maxWorkers=1`. Each overlapped the affected-file qualification run.
Every run kept the 403 cold refusal, saved Deny, zero cold reservations, successful
warm-up, two-second measured call, zero old rows, one added hold and zero provider requests.
There was no admission retry loop and no test retry option.
Durations include startup. Commands used the same PostgreSQL URL and `nice -n 10`.

| Round | Total seconds | Measured admission, ms |
| --- | ---: | ---: |
| 1 | 30.80 | 869 |
| 2 | 32.71 | 609 |
| 3 | 29.82 | 753 |
| 4 | 33.10 | 870 |
| 5 | 32.11 | 1007 |
| 6 | 41.69 | 821 |
| 7 | 41.94 | 1069 |
| 8 | 45.80 | 1367 |
| 9 | 45.46 | 969 |
| 10 | 49.52 | 1211 |
| 11 | 43.33 | 818 |
| 12 | 45.88 | 1257 |
| 13 | 43.80 | 915 |
| 14 | 36.98 | 743 |
| 15 | 37.97 | 786 |
| 16 | 39.13 | 985 |
| 17 | 37.68 | 784 |
| 18 | 32.81 | 1455 |
| 19 | 31.40 | 512 |
| 20 | 25.28 | 587 |

### Final checks

PASS: the final rebase onto `fa3e8c05aafe0079573f43c92d26e1811790e84f`
finished cleanly. Compared file hashes: all 11 checked test files match the tested
source `ab5bb22ea`. The rebase changed no production source or package manifest.
It added main's native-capture tests, documentation and Knip entries.
The repository checks below were repeated after this rebase.

PASS: lint, including Knip; typecheck; `check:events`; `npm run lint:changelog`;
and `git diff --check`. Lint used the existing 8 GB Node heap setting.
The final receipt also passed Markdown and offline link checks.

Safe logs, JSON reports, commands and individual run records are in
`/tmp/ci-flakes-2-review-fix/`. The `final/` directory contains the final source runs;
the parent directory keeps the failing-first and superseded trials.
NOT RUN: full root suite and fresh-install journeys. CI was not awaited.
The pull request remains a draft. Landing was not attempted.

## Earlier source checks

Date: 22 October 2026. Source code: `3b882d50d13a4214ce659d8db613e9a1075d0d3d`.
Environment: Linux, Node 22.23.3, development worktree, not a fresh installation. Tests used
real disposable NATS, PostgreSQL and OpenFGA services and the pinned gateway.
A throwaway database supplied `PG_TEST_URL`. Each file used
`nice -n 10 node_modules/.bin/vitest run <file> --maxWorkers=1`.
A separate Node process kept one CPU busy. Every test and check ran under
`nice -n 10`. Model test files ran one at a time with `--maxWorkers=1`.

### Failing first

PASS: test commit `9b74a8287` reproduces the faults on base `8a334f3ee`.
The old picker returned outgoing-connection ports. A real occupied readiness
port produced only
`Gateway stopped (exit code 1): Error: readiness server starts`, losing the bind cause.
The delayed stderr test lost the same cause. The 15,000-edit call took 224 ms,
but the old assertion failed because it counted three reservations rather than two.
An initial port-fixture trial used a silent TCP listener and timed out; it was
replaced with an HTTP refusal before the test commit.

### File checks

Each row records two separate full-file runs. All results are PASS; durations
include test startup. The event security rules also passed once: 438 tests.

| File | First run, seconds | Second run, seconds |
| --- | ---: | ---: |
| `libs/models/test/gateway-start.test.ts` | 6.79 | 5.66 |
| `libs/models/test/ports.test.ts` | 5.55 | 4.81 |
| `libs/models/test/decision-cost.test.ts` | 279.56 | 202.97 |
| `libs/models/test/egress-admission.test.ts` | 329.36 | 354.53 |
| `libs/models/test/gateway-delivery.test.ts` | 120.59 | 127.53 |
| `apps/server/test/providers.test.ts` | 93.02 | 69.99 |
| `apps/server/test/models-main.test.ts` | 89.2 | 76.36 |
| `apps/server/test/models-managed.test.ts` | 64.05 | 61.98 |
| `apps/server/test/remote-catalogue-dispatch.test.ts` | 48.11 | 44.69 |
| `apps/server/test/live-view-proxy.test.ts` | 97.17 | 93.05 |
| `apps/computer/test/registry-forwarder.test.ts` | 4.91 | 4.88 |

### Twenty consecutive runs under load

Every cell below is PASS. Each decision-cost run selected the 3,000-grant and
15,000-edit tests with `-t '15,000 edits|3,000 model grants'`.
Both force a warm-up refusal, check its zero-cent release,
and keep the measured call's two-second limit. The port runs include a real
gateway bind conflict; the gateway-start runs also check delayed stderr and
withheld private details. Durations are seconds.

| Round | Port tests | Gateway-start tests | Decision-cost tests |
| --- | ---: | ---: | ---: |
| 1 | 6.05 | 5.71 | 60.06 |
| 2 | 4.92 | 5.16 | 54.45 |
| 3 | 4.32 | 4.86 | 63.42 |
| 4 | 4.35 | 5.68 | 49.66 |
| 5 | 4.14 | 4.92 | 67.48 |
| 6 | 4.82 | 6.55 | 70.14 |
| 7 | 6.7 | 8.74 | 72.6 |
| 8 | 5.03 | 5.76 | 60.34 |
| 9 | 4.8 | 5.78 | 50.27 |
| 10 | 4.03 | 4.58 | 57.31 |
| 11 | 4.21 | 4.99 | 60.67 |
| 12 | 5.03 | 4.79 | 51.45 |
| 13 | 4.53 | 5.36 | 49.58 |
| 14 | 4.83 | 4.86 | 45.1 |
| 15 | 4.11 | 4.51 | 54.08 |
| 16 | 4.65 | 4.89 | 65.35 |
| 17 | 4.12 | 4.69 | 72.37 |
| 18 | 4.28 | 5.12 | 57.95 |
| 19 | 4.68 | 5.55 | 57.88 |
| 20 | 4.14 | 5.02 | 66.68 |

### Other checks

PASS: clean `npm ci`, lint (including Knip), typecheck, event catalogue,
changelog check and `git diff --check`. Lint used the same 8 GB Node heap as CI.

PARTIAL: the earlier lint run with Node's 4 GB default was stopped and replaced.
The checked test range is 20000–24999. Secondary stacks use 25100 and 25200;
the host outgoing range starts at 32768. No existing listener used the test
range before the checks started. No dependency was added.

Safe local logs and the individual run records are in
`/tmp/ci-flakes-2-evidence/`. The throwaway database was removed with its volume.
NOT RUN: full root suite and fresh-install journeys. CI is not awaited.
