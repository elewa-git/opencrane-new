# Gateway delivery lock test

Date: 24 October 2026. Part of #576.
Tested source: `9a860212cd1fcf325937f3300d92a433c90dd6c8`.
Base: `2b032bc0142f1f89d4fd564bad13bfd0d93ff504`.

## Cause

Main run [40085952629, first attempt](https://github.com/elewa-git/opencrane-new/actions/runs/40085952629/attempts/1)
failed at `gateway-delivery.test.ts:1043`. Delivery had already rejected. The failed
assertion said that the competing database session did not hold the lock.

The delivery callback runs after the gateway lock has been acquired. The test
pauses a TCP proxy, sends `pg_terminate_backend(pid)`, then immediately tries to
take the same lock from a different session. The default termination call confirms
only that PostgreSQL sent the signal. The old session can still hold its lock when
`pg_try_advisory_lock` samples it. Its false result fails an assertion inside the
delivery callback. Delivery catches that assertion and returns its usual refusal;
the later ownership assertion exposes the failed setup.

The [PostgreSQL documentation](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)
describes this asynchronous termination behaviour.

The fixture now waits for `pg_advisory_lock` to complete, with a two-second database
lock timeout. This waits for ownership without sleeping or retrying a failed test.
Production code is unchanged.

## Failing-first evidence

- PASS: test-only commit `393e9b890` reproduces the setup error. The new regression
  keeps the old lock held and fails because the competitor finishes before release.
  Observed assertion: expected `finished` to be false, received true.
- PASS: the same regression passes with the blocking acquisition. It checks
  `pg_locks` for the waiting competitor before releasing the old lock.
- PASS: both focused tests pass with the fix. The lost-session test checks unchanged
  file bytes and inode, no observation, no member receipt and no new event.
- PASS: a temporary negative control removed the product's final lock-session query.
  The lost-session test failed because the file bytes changed. The query was restored
  before the repeated runs.

## Environment and commands

This work used its own worktree and `npm ci`. NATS and Lychee were symlinked from
the main checkout as requested. The pinned agentgateway binary was downloaded by
the existing fetch script. PostgreSQL 17.6 ran in the throwaway
`pgtest-ci-flakes-9` container, with its allocated loopback port set in `PG_TEST_URL`.
Each test fixture created separate databases. The container was removed afterwards
with `docker rm -f -v pgtest-ci-flakes-9`.

Every lint, typecheck and test command used `nice -n 10`. Each Vitest process used
`--maxWorkers=1`. The delivery file ran sequentially 30 times. One companion process
at a time repeatedly ran `libs/projections/test/runner.test.ts` and
`libs/models/test/gateway-generation.test.ts`, including while delivery runs changed
over. After run 03, the repeats paused briefly while typecheck finished. They resumed
with the same code. No failed iteration was retried. These were test fixtures, with
no dev stack changes.

The commands were:

```sh
npm ci
npm run lint
npm run typecheck
npm run check:events
npm run lint:changelog
npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=1
npx vitest run libs/models/test/gateway-delivery.test.ts --maxWorkers=1
npx vitest run libs/projections/test/runner.test.ts \
  libs/models/test/gateway-generation.test.ts --maxWorkers=1
```

## Results

[Every numbered run and its result](ci-flakes-9-runs.txt) is saved as plain text.

| Check | Result | Observed result |
| --- | --- | --- |
| Clean install | PASS | `npm ci` completed in this worktree. |
| Lint | PASS | All stages passed, including Knip, documentation, links and licences. |
| Typecheck | PASS | All workspaces, package tooling and dev-stack tooling passed. |
| Event catalogue | PASS | All 153 event types agreed. |
| Changelog lint | PASS | The branch fragment passed. |
| Event security rules | PASS | 438 tests passed in one run. |
| Changed tests twice | PASS | Full-file runs 01 and 02 passed all 40 tests each. |
| Lost-lock test under load | PASS | 30/30, with unchanged bytes, inode and event position. |
| Fixture wait regression under load | PASS | 30/30, waiting on the actual PostgreSQL lock. |
| Complete delivery file under load | FAIL | 28 passing runs; runs 03 and 18 failed. |
| Companion tests | PASS | 118 invocations, each with 15 passing tests. |

Run 03 timed out after 30 seconds in the unchanged
`rejects invalid control ports and hides file error details` test.
Run 18 failed in the unchanged `refuses a receipt with a different recordDigest` test:
its initial fixture delivery was refused by the existing child-process check.
Each failed file still passed the other 39 tests, including both lock tests.
Neither failure was retried or treated as a pass. The stress gate remains FAIL.
These other fixture failures are unresolved in this draft.

The full root suite and fresh-install journeys were NOT RUN, as this task changes
test synchronisation only. CI on the pushed branch is left to the orchestrator.
