# CI flake checks

Date: 22 October 2026. Source code: `3b882d50d13a4214ce659d8db613e9a1075d0d3d`.
Environment: Linux, Node 22.23.3, development worktree, not a fresh installation. Tests used
real disposable NATS, PostgreSQL and OpenFGA services and the pinned gateway.
A throwaway database supplied `PG_TEST_URL`. Each file used
`nice -n 10 node_modules/.bin/vitest run <file> --maxWorkers=1`.
A separate Node process kept one CPU busy. Every test and check ran under
`nice -n 10`. Model test files ran one at a time with `--maxWorkers=1`.

## Failing first

PASS: test commit `9b74a8287` reproduces the faults on base `8a334f3ee`.
The old picker returned outgoing-connection ports. A real occupied readiness
port produced only
`Gateway stopped (exit code 1): Error: readiness server starts`, losing the bind cause.
The delayed stderr test lost the same cause. The 15,000-edit call took 224 ms,
but the old assertion failed because it counted three reservations rather than two.
An initial port-fixture trial used a silent TCP listener and timed out; it was
replaced with an HTTP refusal before the test commit.

## File checks

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

## Twenty consecutive runs under load

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

## Other checks

PASS: clean `npm ci`, lint (including Knip), typecheck, event catalogue,
changelog check and `git diff --check`. Lint used the same 8 GB Node heap as CI.

PARTIAL: the earlier lint run with Node's 4 GB default was stopped and replaced.
The checked test range is 20000–24999. Secondary stacks use 25100 and 25200;
the host outgoing range starts at 32768. No existing listener used the test
range before the checks started. No dependency was added.

Safe local logs and the individual run records are in
`/tmp/ci-flakes-2-evidence/`. The throwaway database was removed with its volume.
NOT RUN: full root suite and fresh-install journeys. CI is not awaited.
