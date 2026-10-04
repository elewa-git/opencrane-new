# Readable computer channel evidence

Receipt date: 2026-10-04. The `work/i126-computer-channel` branch started at
`13196d8f3800a75cfbf9cf59f7d0c759cc4e4193` and was later rebased onto `f6d959f`.
The Vitest runs below were completed before that rebase. Lint, typecheck and event
catalogue checks were rerun on `f6d959f`. The checkout used Linux x86-64 with Node
22.23.3 and was a local development checkout, not a fresh silo.

## Source checks

| Command | Result | Evidence |
| --- | --- | --- |
| `nice -n 10 npm run lint` | PASS | ESLint, dependency, unused-code, Markdown, links and fixture checks completed. |
| `nice -n 10 npm run typecheck` | PASS | All workspace TypeScript checks completed. |
| `nice -n 10 npm run check:events` | PASS | 85 event types agree between registry and catalogue. |
| Focused bridge, replay and suspend tests, `--maxWorkers=2` | PASS | 3 files, 14 tests passed after the refactor and restart-test correction. |
| `nice -n 10 npm test -w apps/web` | PASS | 11 files, 60 tests passed. |
| Independent review and fix verification | PASS | One restart-test collector race was found and fixed; the second pass confirmed it. |

The two added restart and crash-recovery characterisation tests passed against the
original channel before the refactor. Existing interrupt and duplicate-delivery
assertions were left unchanged.

## Full root suite

Both complete root-suite attempts used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and
`nice -n 10 npm test -- --maxWorkers=2` after checking host load.

| Attempt | Result | Follow-up |
| --- | --- | --- |
| First | FAIL: 1,449 passed, 15 skipped; a live-view event-store subscription timed out waiting for NATS. | The failing live-view test passed alone on retry: 1 passed, 14 skipped. |
| Second | FAIL: 1,449 passed, 15 skipped; the gateway fixture stopped during startup in a provider 401 test. | The failing gateway test passed alone on retry: 1 passed, 79 skipped. |

The focused bridge, replay and reconnect coverage is green. The full root suite has
not completed without an unrelated service-fixture failure, so the root-suite gate
remains PARTIAL. The active shared-host live-view qualification prevented another
Vitest run after the rebase; the computer bridge source itself did not change in the
rebase.

## Review 1 follow-up

The four requested behaviour characterisations are committed alongside the existing
restart, recovery and Stop tests. The bridge-channel tests pass against both this
branch and `origin/main`'s `apps/computer` implementation. The `origin/main` run used
the same server test file with the temporary worktree's NATS test binary supplied
from the existing checkout. Final focused runs passed 11/11 bridge-channel tests
on both implementations and 18/18 bridge-channel, replay and suspend tests here.

Review item B1, `approvals.test.ts:42` returning 503 during concurrent decisions,
is the known #136 read-retry flake. The open `work/i136-read-retry` branch addresses
that retry; approvals code is unchanged in this change. Any occurrence in the root
suite is recorded as a separate unrelated failure, not attributed to this refactor.

The requested final root run used the specified PostgreSQL URL and
`nice -n 10 npm test -- --maxWorkers=2`. It completed **PARTIAL**: 91 files passed,
2 failed and 4 were skipped (1,493 tests passed, 2 failed and 15 skipped). The
failures were the gateway ambiguous-provider reservation test (40-second timeout)
and the event-store append/race test (NATS stream-info request timeout). Each failing
case passed in an isolated retry under `nice -n 10`. The approvals 503 case did not
fail in this run. The two root-suite failures remain recorded as failures; the
isolated retries do not turn the root gate green.
