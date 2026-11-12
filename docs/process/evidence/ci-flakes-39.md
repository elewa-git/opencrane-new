# Approval evidence deadline arithmetic

Journey on a fresh dev stack: NOT RUN (core journey)

## Source and environment

12 November 2026. Base: `90a99afa75e508f32c505d82a4beacc45e236dfd`.
Reproduction: `9faba6f46`. Correction: `4e182f9fd`.
Node 22.23.3 on Linux x86-64, with a clean `npm ci` in this worktree.
Tests use the shared disposable PostgreSQL service and private fixture databases,
NATS, OpenFGA and the pinned gateway. Every test and gate runs under `nice -n 10`.
These fixtures are separate from the fresh-stack journey.

## Cause and reproduction

The product sets the refusal evidence deadline to `performance.now() + 1000`.
The test subtracted the fractional current time again. Floating-point addition
and subtraction are not inverses at every magnitude: the recovered duration can
exceed 1,000 ms even when the absolute deadline is exactly the expected value.

The first commit fixes the starting clock at `64000.00299999999` and retains the
original assertion. After the admission refusal advances time by 1,000 ms, the
current time is `65000.00299999999` and the product deadline is `66000.003`.
Subtracting produces `1000.0000000000073`. The focused failed-read case reproduced
the exact main CI assertion failure on demand. An earlier setup attempt failed
because the pinned gateway binary had not yet been fetched; that is separate
from the successful reproduction.

The correction compares the captured deadline directly with `currentTime() + 1000`.
It preserves the exact limit without a tolerance or rounding. Product code is
unchanged. The same helper checks all four incomplete-proof cases.

## Sibling checks and test strength

The sibling timing tests changed in #989 use controlled elapsed values and product
outcomes. Approval races round remaining time only for diagnostic traces, while
history tests check integer elapsed values, refusal status, connections and
reservations. Neither repeats the failing duration assertion. Frozen-clock timing
checks subtract identical readings. No new shared timing helper is needed.

PASS: all four incomplete-proof cases with the corrected assertion.

PASS: a temporary mutation changed the product evidence allowance from `1000` to
`1000.0000000001`. The failed-read test rejected `66000.00300000008` against
`66000.003` at the new assertion. The product source was restored immediately.
This proves that the corrected assertion still rejects a representable overrun.
The mutation log is `/tmp/ci-flakes-39-mutation.log` on the builder host.

## Gates

- PASS: changed-file ESLint, with no warnings.
- PASS: `check:events`, 174 event types agree.
- PASS: Knip; two configuration hints, no unused-code failure.
- PASS: `lint:changelog` and Markdown lint with no file arguments.
- PASS: full typecheck, including package and dev-stack checks.
- PASS: ten consecutive full-file test runs, 23/23 each (230 passing test executions).

Full-file runs use:

```sh
nice -n 10 npx vitest run apps/server/test/integration-access-gateway.test.ts --maxWorkers=2
```

| Run | Tests | Seconds |
| --- | --- | --- |
| 1 | PASS: 23/23 | 174.44 |
| 2 | PASS: 23/23 | 186.42 |
| 3 | PASS: 23/23 | 317.15 |
| 4 | PASS: 23/23 | 230.31 |
| 5 | PASS: 23/23 | 210.04 |
| 6 | PASS: 23/23 | 233.72 |
| 7 | PASS: 23/23 | 290.42 |
| 8 | PASS: 23/23 | 185.25 |
| 9 | PASS: 23/23 | 264.10 |
| 10 | PASS: 23/23 | 201.07 |

The test loop stops on the first failure. Per-run logs are
`/tmp/ci-flakes-39-run-<number>.log`; the typecheck log is
`/tmp/ci-flakes-39-typecheck.log` on the builder host.

## Fresh stack

FAIL: one secondary `up.sh --fresh` attempt exited 1 after the development
bootstrap, provider setup and website readiness checks. The website became ready
in 42,005 ms. The runner returned its generic startup failure message.

NOT RUN: the core journey. This task has `OPENCRANE_FLEET_TASK` set, and
`requireAutomatedJourney` refuses that environment even on a claimed secondary.
A direct guard check with a secondary id returned
`Automated journeys require a secondary stack and no fleet task`. The startup
path invokes that guard after website readiness. No journey PASS is claimed.

PASS: the exit handler ran `down.sh` successfully (exit 0), releasing the claimed
secondary slot. No owner-stack command was used. Teardown removed the private
stack directory, so its detailed failure files are unavailable. Retained wrapper
logs are `/tmp/ci-flakes-39-journey.log` and `/tmp/ci-flakes-39-down.log` on the
builder host. No second fresh-start attempt or guard bypass was made.

## Remaining checks

NOT RUN: full root suite, separate web build/tests and hosted CI. This repair changes
only test arithmetic. The draft PR does not claim that main has become green.
