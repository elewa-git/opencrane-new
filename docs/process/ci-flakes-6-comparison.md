# NATS provisioning: paired main and branch runs

Date: 23 October 2026. Tested main: `369730231af315fb4067b84efa01e85e227b572b`.
Tested branch: `604830c492fc6317722ab2319ff2a71a444a5d13`.
The branch was rebased onto that fetched main commit before these runs.
The rebase completed, and main was checked to be an ancestor of the branch.

## Result

The requested comparison is **PASS**: all 40 full-file runs passed. The branch
did not fail more often than main. The original timeout attribution remains
**PARTIAL**: none of those timeouts was reproduced. These results establish
neither a confirmed existing flake nor a branch regression. Ten runs per file
and source do not rule out an occasional failure. The earlier failed runs remain
failed and unclassified; this comparison does not change their recorded results.

| Suite | Main | Branch |
| --- | --- | --- |
| `runtime.test.ts` | PASS, 10/10 runs, 180 tests | PASS, 10/10 runs, 180 tests |
| `upgrade.test.ts` | PASS, 10/10 runs, 420 tests | PASS, 10/10 runs, 420 tests |

There were no failed runs, so there is no failed run's last completed step
to report. Every run finished its test bodies and cleanup. The temporary trace
retains the completed and pending operations for each case, including every
rollback/backoff, dispatcher recovery, backfill, unfinished created-job refusal,
failed-original cancellation and malformed cancellation-ID case.

The five-second SDK management timeout remains in place. This follow-up changes
only this evidence file. It changes no behaviour, assertion, access check, money
check, memory check or test deadline. The earlier test-first and fix commits remain
separate. A new failing-first test was not needed for this documentation change.

## Method

The clean, detached main worktree was `/tmp/ci-flakes-6-fix1/main`. It had its own
`npm ci` install. Its `git status --short` was empty before and after the runs.
Both checkouts had the same package-lock checksum and used Node
22.23.3, Vitest 5.0.3, PostgreSQL 17.11 and NATS 2.15.0. The PostgreSQL URL was
`postgres://postgres:test@127.0.0.1:55432/postgres`, as requested. Each case created
its usual separate database and NATS fixture. No development stack was started.

Each round ran runtime on main, runtime on the branch, upgrade on main, then
upgrade on the branch. All runs were back to back, with `nice -n 10` and
`--maxWorkers=1`. No companion suite or artificial load was added. Other users'
work made host load vary. The full `/proc/loadavg` value was saved immediately
before each start, and again when each run ended. The first three numbers are the
one-, five- and fifteen-minute load averages; the remaining fields are the process
counts and latest process ID.

One-minute start loads: main: mean 7.89, range 3.30–15.18; branch: mean 7.95, range 2.88–15.64.

An external Vitest configuration added the same await trace to both checkouts
at module loading time. Source files stayed unchanged. The trace covered the two
test files, their shared handler helper and the NATS fixture. It saved the test
name, source line, operation, start, completion or rejection, and time. It wrote
no returned values. This tracing adds a small amount of work, so these are
diagnostic runs. Assertions and the 30-second test limits stayed unchanged.

The command in each checkout was:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
ATTRIBUTION_TRACE=/tmp/ci-flakes-6-fix1/<run>.trace.jsonl \
nice -n 10 node node_modules/vitest/vitest.mjs run \
  libs/handlers/test/<suite>.test.ts --maxWorkers=1 \
  --config /tmp/ci-flakes-6-fix1/config-<source>.mjs \
  --reporter=verbose --reporter=json \
  --outputFile=/tmp/ci-flakes-6-fix1/<run>.json
```

## Per-run record

Every entry below is PASS: runtime ran 18 tests and upgrade ran 42 tests.

| Round / suite | Main seconds | Main start `/proc/loadavg` | Branch seconds | Branch start `/proc/loadavg` |
| --- | --- | --- | --- | --- |
| 01 / runtime | 139.32 | `15.18 10.19 7.83 12/1655 3071730` | 134.79 | `15.64 12.05 8.84 12/1661 3080315` |
| 01 / upgrade | 253.51 | `11.11 11.93 9.26 4/1570 3087814` | 282.91 | `6.59 9.29 8.85 6/1541 3101700` |
| 02 / runtime | 112.21 | `8.23 9.15 8.95 10/1533 3118234` | 106.47 | `6.38 8.40 8.72 4/1498 3122901` |
| 02 / upgrade | 259.60 | `6.89 7.99 8.53 5/1431 3131092` | 264.76 | `5.45 6.38 7.74 2/1341 3144629` |
| 03 / runtime | 99.80 | `4.57 5.01 6.77 4/1348 3158678` | 109.39 | `2.88 4.38 6.37 6/1400 3164807` |
| 03 / upgrade | 245.57 | `3.30 4.17 6.08 2/1378 3171799` | 246.88 | `4.39 4.23 5.64 6/1424 3184279` |
| 04 / runtime | 108.57 | `5.67 5.25 5.74 9/1552 3196927` | 122.06 | `8.67 6.58 6.18 15/1652 3202287` |
| 04 / upgrade | 377.26 | `9.56 7.71 6.65 15/1673 3208243` | 329.18 | `12.82 11.28 8.61 10/1755 3228017` |
| 05 / runtime | 133.35 | `7.63 9.95 8.94 6/1584 3246016` | 115.44 | `12.20 10.95 9.44 9/1753 3255520` |
| 05 / upgrade | 272.28 | `9.78 10.59 9.50 6/1621 3262537` | 262.91 | `7.99 9.32 9.27 5/1553 3277186` |
| 06 / runtime | 101.06 | `7.17 8.41 8.92 5/1499 3291741` | 112.50 | `5.82 7.60 8.58 7/1547 3297568` |
| 06 / upgrade | 257.79 | `5.66 7.04 8.27 8/1496 3303384` | 242.19 | `4.46 6.23 7.67 8/1490 3317548` |
| 07 / runtime | 108.12 | `4.42 5.34 6.97 2/1483 3334217` | 108.75 | `6.21 5.70 6.91 5/1526 3340127` |
| 07 / upgrade | 303.88 | `6.37 5.74 6.78 8/1630 3346184` | 279.68 | `8.73 8.28 7.65 4/1662 3362749` |
| 08 / runtime | 104.69 | `8.09 8.58 7.97 7/1646 3381125` | 105.11 | `8.34 8.38 7.95 5/1579 3387415` |
| 08 / upgrade | 259.02 | `7.31 7.98 7.86 9/1722 3394059` | 271.48 | `5.76 6.99 7.47 3/1534 3411419` |
| 09 / runtime | 108.92 | `6.79 6.56 7.15 1/1555 3427693` | 109.34 | `5.23 6.24 6.98 4/1542 3434948` |
| 09 / upgrade | 257.94 | `7.66 6.48 6.96 8/1537 3443529` | 309.28 | `5.86 7.10 7.18 3/1398 3463301` |
| 10 / runtime | 129.02 | `10.06 9.60 8.29 11/1584 3486627` | 124.54 | `13.88 10.90 8.92 21/1686 3496413` |
| 10 / upgrade | 319.97 | `12.27 11.26 9.30 11/1687 3503081` | 248.32 | `11.68 11.74 10.11 14/1555 3518730` |

## Retained logs and limits

The logs, JSON reports, per-operation traces and harness files remain in
`/tmp/ci-flakes-6-fix1/` on the builder host. `compare.py` ran the comparison;
`make-config.mjs` and `trace.mjs` supplied the temporary tracing. `results.jsonl`
records each source commit, command, UTC start, start/end load, exit code and
duration. `summary.json` records test counts. Each run also has `.start.json`,
`.json`, `.log` and `.trace.jsonl` files. The main worktree was removed after the
comparison; these logs remain outside it.

The earlier failures are retained in `/tmp/ci-flakes-6-checks/`. They lacked the
operation trace needed to say which operation used their whole-test allowance.
This follow-up makes no claim about their blocked operation or cause.

Full root suite and fresh-install live qualification: **NOT RUN** in this round.
The PR stays in draft. These local results make no landing decision.
