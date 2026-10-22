# Status-code tests under load

Date: 22 October 2026. Base: `4fb9a34b2a23316f29e0e34ee55ae91848b794f1`.
Environment: Node 22.23.3, Linux, this development worktree; not a fresh installation.

## Causes

| Test | Cause of 503 | Change |
| --- | --- | --- |
| Memory correction racing Forget | The second request can reach memory admission while the first request still holds the member/scope slot. `acquireMemoryWrite` throws `MemoryBusy`; the HTTP handler returns `memory_busy`. No deadline has to expire. | Capture old history, then wait for the first response before continuing the stale-revision check. |
| Decision cost with 3,000 grants | A warm-up can reach a saved Allow and then exceed the two-second admission deadline. Failure after an attempted audit returns `Decision audit unavailable`. Cold-history timing made the warm-up outcome vary. | Reuse the grant-history fixture fix from PR #582: require a controlled cold-history 403, finish history directly, then measure later admissions. |
| Child recovery status reads | Cleanup repeatedly added team membership even when no member had been removed. The extra receipt checks exhausted the two-second child review access deadline. | Already fixed by #563 on this branch's base: restore membership only after removal. |

The memory race previously released the first append after the second history read,
but did not wait for the first write to finish. Parallel test files can change
which request reaches admission first. The returned busy response is required by
[the existing memory limits](../../../apps/server/README.robot.md#memory-scope-and-search-reads).
The test now chooses the ordering needed to check a stale revision. It still
requires 200 for the first request, 409 for the second, one append and an available
new revision key. Production files and defaults are unchanged.

The one-second OpenFGA HTTP limit and the 100 ms database-lock and tail-read limits
remain unchanged. Neither starts the reproduced memory busy response. The two-second
write authority deadline is unchanged. Neither repaired assertion accepts 503.
No new retry loop is added, and no authority test is edited.

## CI and failing-first evidence

- Main run [39819954120, attempt 1](https://github.com/elewa-git/opencrane-new/actions/runs/39819954120/attempts/1)
  reports the memory race at `memory.test.ts:342`: expected 409, received 503.
- PR #582 run [39808257688](https://github.com/elewa-git/opencrane-new/actions/runs/39808257688)
  reports the 3,000-grant warm-up assertion: expected 200 or 403, received 503.
  Its later 15,000-edit measurement passed at 53 ms. The grant warm-up fix is
  taken from that PR's later commit `898903b8615b581317eef09a91b978c2b7469dcb`.
- The existing child cleanup diagnosis is recorded in the server's
  [fixture notes](../../../apps/server/README.robot.md#recovery-fixture-cleanup).
- Expected FAIL: test-first commit `dd24c7023` holds the first correction until
  the second request asks for admission. Correction/Forget returns exactly
  503 `memory_busy`; correction/correction passes its conflict check.
- PASS: after waiting for the first response at the end of the second history
  read, both targeted races pass with their original 200/409 assertions.

Local logs are `/tmp/ci-flakes-3-main.log`, `/tmp/ci-flakes-3-pr582.log`,
`/tmp/ci-flakes-3-red.log` and `/tmp/ci-flakes-3-green-focused.log`.

## Validation

Test code: `0bd5738b205f4bdf4bcaadb888b0e2c2ee8b82c2`.
The test code stayed unchanged throughout the repetitions. Later changes only
complete these notes and move a README paragraph away from an upstream insertion.

PASS: `npm ci` completed in this worktree. The requested NATS and lychee links
point to the owner worktree's binaries. `npm run pretest` fetched and checked the
pinned gateway before the recorded repetitions. An earlier diagnostic lacked that
binary; its incomplete baseline was cancelled and is not counted as a test result.

Each of the three complete files ran 20 times, once per batch, with three workers.
No failed case was retried within a batch. Every suite and check used `nice -n 10`.
The parent already had nice value 10, so test children ran at 19. A separate process
ran at the same priority, using 10 ms of CPU then sleeping for 10 ms, on CPUs 4–7.
Other work on this shared host continued. Batch 1 also restricted the suites to
CPUs 4–7 while lint and typecheck ran. Batches 2–20 used all eight available CPUs.
These are local load checks, not timings from a hosted runner.

All fixtures used the throwaway PostgreSQL container `pgtest-ci-flakes-3` at
`PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:54439/postgres`, plus their
normal disposable NATS and OpenFGA services and the pinned gateway. The database
container and its volumes were removed after the last batch. The load process stopped.

The command for each batch was:

```sh
PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:54439/postgres \
  nice -n 10 npx vitest run \
  apps/server/test/memory.test.ts \
  libs/models/test/decision-cost.test.ts \
  apps/server/test/child-recovery.test.ts \
  --maxWorkers=3
```

PASS: each investigated case passed 20/20, including both correction races,
the 3,000-grant case and both reported child recovery cases: 100/100 observations.
The 3,000-grant measured admissions took 436–1,246 ms and read no old grant rows.

FAIL: the full files did not all pass. Nine batches passed all 301 tests; eleven
had other failures. Memory passed 13/20 complete runs, decision cost 11/20 and
child recovery 20/20. The 15,000-edit case failed in batch 9 and remains FAIL.
The nine-model cache case, cold-process catch-up, preview setup/cleanup, binding
replay and other command cases also have recorded failures. These cases are
unchanged by this fix. Their failures have not been repaired or treated as passes.
This change is not fully qualified for landing.

The number in brackets is the failed test count for that file.

| Batch | Memory, 240 tests | Decision cost, 25 tests | Child recovery, 36 tests |
| --- | --- | --- | --- |
| 1 | FAIL (6) | FAIL (2) | PASS |
| 2 | PASS | FAIL (1) | PASS |
| 3 | PASS | FAIL (1) | PASS |
| 4 | PASS | FAIL (1) | PASS |
| 5 | PASS | PASS | PASS |
| 6 | FAIL (15) | FAIL (2) | PASS |
| 7 | FAIL (1) | PASS | PASS |
| 8 | FAIL (6) | FAIL (2) | PASS |
| 9 | FAIL (20) | FAIL (3) | PASS |
| 10 | PASS | FAIL (1) | PASS |
| 11 | PASS | PASS | PASS |
| 12 | PASS | PASS | PASS |
| 13 | PASS | PASS | PASS |
| 14 | PASS | PASS | PASS |
| 15 | PASS | PASS | PASS |
| 16 | PASS | PASS | PASS |
| 17 | PASS | PASS | PASS |
| 18 | PASS | PASS | PASS |
| 19 | FAIL (1) | PASS | PASS |
| 20 | FAIL (1) | FAIL (1) | PASS |

The failures below stay open. A failed preview setup can leave facts for later
preview assertions because it fails before the existing cleanup block.
Binding replay repeatedly reached the 30-second test limit. The cold-process
case reported an event-store read timeout, and the nine-model case returned 403.
These observations do not establish the remaining causes.

| File | Failed case | Batches |
| --- | --- | --- |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes expired | 1, 6, 9 |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes destroyed | 1, 6, 9 |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes missing | 1, 6, 9 |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes damaged | 1, 6, 8, 9 |
| memory.test.ts | omits preview text when a supporting key is destroyed after candidate selection | 1, 6, 8, 9 |
| memory.test.ts | uses category then bytewise id order, includes unpinned preferences once and omits denied scopes | 1, 6, 8, 9 |
| decision-cost.test.ts | lets a cold models process catch up and then admits using only the chat tail | 1, 6, 8, 9 |
| decision-cost.test.ts | keeps 10,000 members on one model and eight models with 1,000 members cached in one process | 1, 2, 3, 4, 6, 8, 9, 10, 20 |
| memory.test.ts | previews empty private memory without dispatch or another owner reading it | 6 |
| memory.test.ts | keeps the preview available when another turn starts during the read | 6, 8 |
| memory.test.ts | counts JSON bytes, stops at the first overflow and never backfills | 6 |
| memory.test.ts | counts UTF-8 bytes, stops at the first overflow and never backfills | 6, 9 |
| memory.test.ts | admits an exact 16 KiB block and refuses the next byte | 6, 9 |
| memory.test.ts | admits at most 32 references and does not report hidden totals | 6 |
| memory.test.ts | conflicts when a reconciled command has different saved input | 6 |
| memory.test.ts | keeps a delayed append readable after status checks an expired unknown command | 6, 9 |
| memory.test.ts | rebuilds binding status without any key, model, tool, computer or scheduler port | 6, 7, 8, 9, 19, 20 |
| memory.test.ts | checks the original command after an accepted append loses its reply | 8 |
| memory.test.ts | stores human facts with separate write rights and no administrative bypass | 9 |
| memory.test.ts | refuses private sources, shared preferences, forged statements and controls | 9 |
| memory.test.ts | reconciles a prepared key and its temporary copy after restart | 9 |
| memory.test.ts | keeps no text or text hash in a journal and removes resolved records | 9 |
| memory.test.ts | refuses a busy command lock promptly and keeps the database usable | 9 |
| memory.test.ts | reports failure through status only after another scope write and the append window | 9 |
| memory.test.ts | reports failure through recovery only after another scope write and the append window | 9 |
| memory.test.ts | keeps older unknown keys when their expected scope position was not recorded | 9 |
| memory.test.ts | shows blocked and missed history only to the binding owner | 9 |
| memory.test.ts | forgets from metadata after key destruction and reports terminal cleanup without custody | 9 |
| decision-cost.test.ts | keeps 15,000 edits to one model grantee on later reads within two seconds | 9 |

PASS: full lint (zero errors, 24 existing warnings), full typecheck, event
catalogue agreement (149 types), Knip through full lint and changelog lint.
Lint used `NODE_OPTIONS=--max-old-space-size=6144`. PASS: all 438 tests in
`libs/events/test/security-rules.test.ts`. Both changed test files also passed
completely together in batches 5 and 11–18; the failed runs remain FAIL above.

Reports are `/tmp/ci-flakes-3-repeat-01.json` through
`/tmp/ci-flakes-3-repeat-20.json`, with matching `.log` files. The summary is
`/tmp/ci-flakes-3-repeat-results.json`. Check logs use `/tmp/ci-flakes-3-` with
`lint`, `typecheck`, `events`, `changelog` and `security` suffixes.

NOT RUN: full root suite and fresh-install journeys. CI is left to the watcher
after the draft PR is opened.
