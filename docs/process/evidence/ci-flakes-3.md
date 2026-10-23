# Status-code tests under load

Original checks: 22 October 2026. Original base: `4fb9a34b2a23316f29e0e34ee55ae91848b794f1`.
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

## Corrections and new checks

The branch was rebased onto `9367396af`. Both documentation conflicts kept the
newer main notes. The rebase finished, and `git merge-base --is-ancestor origin/main HEAD`
passed before these checks started.

The stale-revision race schedule remains. A separate correction test holds the first
append until the second HTTP response arrives. It requires 409 while the write slot
is occupied, one append, a successful first response and an available revision key.
PASS: this test passes with the existing production guard. Expected FAIL: removing
only the `MemoryBusy` to `MemoryConflict` conversion changes its reply to 503.
The production file was restored after that check.

Grant preparation now waits for each latest requester and assistant grant receipt
through `auth.applied(eventId)`, after loading history. These are the grants used by
this fixture's call. Other people's grants do not decide this call's access. A test
adds a requester grant without applying it. Preparation must observe its missing
receipt and wait. Only the normal handler then applies that grant to OpenFGA.
Expected FAIL before the wait: preparation finished before checking that receipt.
PASS after the wait: the receipt is applied before warm-up, and admission holds
money once without contacting the provider.

There is also a separate way for warm-up to return 403. The fixture's token issuer
uses a frozen clock. Calling `issue()` again therefore does not renew its two-minute
turn token after lengthy preparation. The old batch 9's 15,000-edit case took
129.44 seconds. Its timing is consistent with token expiry; the old log did not
record the internal error. A deterministic regression moves the issuer clock back
121 seconds and reproduces 403 with zero reservations. Waiting for real grant
receipts alone does not repair that expired token. Expected FAIL: issuing again
still returns 403. PASS: signing a fresh token from the real clock returns 200,
with the same turn claims and normal 120-second lifetime. All three requests in
the grant-volume helper now use that preparation. No admission is retried.

Own failing-first commits: `ffcf69d3c` for the missing grant receipt and occupied
correction, followed by the receipt fix `a3f7a2204`; `e2f43266b` for the expired
token, followed by the fresh-token fix `821ed6db7`. PASS: the two new decision
regressions and both grant-volume cases passed together before repetitions began.
The memory check was also run with and without its production guard.

Logs use `/tmp/ci-flakes-3-fix-` with `memory-green`, `memory-mutation`,
`receipt-red`, `receipt-green`, `token-red` and `decision-focused` suffixes.

## Remaining warm-up refusal

FAIL: the 3,000-grant case returned 403 at its successful warm-up assertion in
new batch 16, before the measured admission (`decision-cost.test.ts:494`). The
fixture already waited for the requester and assistant grant receipts and signed
a fresh turn token. This is an affected case. It is not counted as a pass or
explained by the earlier expired-token proof. Its internal refusal reason was
not captured, so the warm-up issue remains open.

PASS: a separate focused diagnostic ran both grant-volume cases together. Another
ten separate focused runs of the 3,000-grant case passed. Temporary error logging
captured the expected cold-read timeouts but did not reproduce the warm-up refusal.
Those focused diagnostics are extra checks, not replacements for failed full runs.
The last diagnostics overlapped batches 17 and 18. Batch 18 loaded the temporary
error logging; the production file was restored before batch 19. No production
condition or deadline was changed, and no diagnostic logging is committed.

Logs are `/tmp/ci-flakes-3-fix-refusal-diagnostic.log` and
`/tmp/ci-flakes-3-fix-refusal-1.log` through
`/tmp/ci-flakes-3-fix-refusal-10.log`. The full run reports retain every failure.
This change remains PARTIAL and the PR remains draft.

## Current static checks

PASS: full lint, full typecheck, event catalogue agreement (149 types), separate
Knip and changelog lint. Full lint reported zero errors and 24 warnings in unchanged
production files. It used `NODE_OPTIONS=--max-old-space-size=6144`. Every command
used `nice -n 10`. The changed test files also passed focused ESLint.

Logs use `/tmp/ci-flakes-3-fix-` with `lint`, `typecheck`, `events`, `knip`,
`changelog` and `eslint-focused` suffixes. Documentation lint also passed after
the new explanations were added.

## New load checks

Dates: 22–23 October 2026. Test code: `821ed6db7`.
Both changed complete files ran 20 consecutive times,
with `child-recovery.test.ts` supplying a third worker. There were no retries or
changes to tests between batches. All commands used `nice -n 10`. A separate
process used 10 ms of CPU then slept for 20 ms throughout. Full lint and typecheck
also ran alongside the first batch. Other shared-host work continued.

All fixtures used the throwaway PostgreSQL container `pgtest-ci-flakes-3-fix`,
with `PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:54889/postgres`. Its
readiness check passed before testing. Tests started their normal NATS, OpenFGA
and gateway fixtures. The database container and its volumes were removed after
the last batch, and the CPU load process stopped.

The command for each batch was:

```sh
PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:54889/postgres \
  nice -n 10 npx vitest run \
  apps/server/test/memory.test.ts \
  libs/models/test/decision-cost.test.ts \
  apps/server/test/child-recovery.test.ts \
  --maxWorkers=3
```

The number in brackets is the failed test count for that file.

| Batch | Memory, 241 tests | Decision cost, 27 tests | Child recovery, 36 tests |
| --- | --- | --- | --- |
| 1 | PASS | FAIL (1) | PASS |
| 2 | PASS | PASS | PASS |
| 3 | PASS | PASS | PASS |
| 4 | PASS | PASS | PASS |
| 5 | FAIL (2) | FAIL (1) | PASS |
| 6 | PASS | PASS | PASS |
| 7 | PASS | FAIL (1) | PASS |
| 8 | PASS | PASS | PASS |
| 9 | PASS | PASS | PASS |
| 10 | PASS | PASS | PASS |
| 11 | PASS | PASS | PASS |
| 12 | PASS | PASS | PASS |
| 13 | PASS | FAIL (1) | PASS |
| 14 | PASS | FAIL (1) | PASS |
| 15 | PASS | FAIL (1) | PASS |
| 16 | FAIL (9) | FAIL (3) | PASS |
| 17 | PASS | PASS | PASS |
| 18 | PASS | PASS | PASS |
| 19 | PASS | PASS | PASS |
| 20 | FAIL (6) | FAIL (2) | PASS |

- memory.test.ts: 17/20 complete runs passed.
- decision-cost.test.ts: 12/20 complete runs passed.
- child-recovery.test.ts: 20/20 complete runs passed.

- PASS: personal HTTP correction allows one change when correction races correct: 20/20.
- PASS: personal HTTP correction allows one change when correction races forget: 20/20.
- PASS: personal HTTP correction returns conflict when another correction still occupies the write slot: 20/20.
- PASS: refreshes an expired fixture turn token before warming admission: 20/20.
- PASS: waits for the latest model grant receipt before warming admission: 20/20.
- FAIL: reads 3,000 model grants before the access check and admits within two seconds on later rows: 19/20.
- PASS: keeps 15,000 edits to one model grantee on later reads within two seconds: 20/20.

The 3,000-grant measured admissions took 385–854 ms (19 measurements).
The 15,000-grant measured admissions took 71–286 ms (20 measurements).

FAIL: complete-file qualification has the following recorded failures.
No failed run is counted as a pass.

| File | Failed case | Batches |
| --- | --- | --- |
| decision-cost.test.ts | keeps 10,000 members on one model and eight models with 1,000 members cached in one process | 1, 7, 13, 14, 15, 16, 20 |
| memory.test.ts | personal HTTP correction recovers a saved correction across restart without resending | 5 |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes expired | 5 |
| decision-cost.test.ts | lets a cold models process catch up and then admits using only the chat tail | 5, 16, 20 |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes missing | 16, 20 |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes damaged | 16, 20 |
| memory.test.ts | omits preview text when a supporting key is destroyed after candidate selection | 16, 20 |
| memory.test.ts | keeps the preview available when another turn starts during the read | 16 |
| memory.test.ts | uses category then bytewise id order, includes unpinned preferences once and omits denied scopes | 16, 20 |
| memory.test.ts | counts JSON bytes, stops at the first overflow and never backfills | 16 |
| memory.test.ts | counts UTF-8 bytes, stops at the first overflow and never backfills | 16 |
| memory.test.ts | admits an exact 16 KiB block and refuses the next byte | 16 |
| memory.test.ts | rebuilds binding status without any key, model, tool, computer or scheduler port | 16 |
| decision-cost.test.ts | reads 3,000 model grants before the access check and admits within two seconds on later rows | 16 |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes destroyed | 20 |
| memory.test.ts | keeps a delayed append readable after status checks an expired unknown command | 20 |

Reports use `/tmp/ci-flakes-3-fix-repeat-01.json` through
`/tmp/ci-flakes-3-fix-repeat-20.json`, with matching `.log` files. The summary is
`/tmp/ci-flakes-3-fix-repeat-results.json`.

NOT RUN: full root suite and fresh-install journeys. The PR remains draft.
CI was not awaited.

## Earlier load checks

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
