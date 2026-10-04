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
