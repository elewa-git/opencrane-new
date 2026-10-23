# Status-code tests under load

Original checks: 22 October 2026. Original base: `4fb9a34b2a23316f29e0e34ee55ae91848b794f1`.
Environment: Node 22.23.3, Linux, this development worktree; not a fresh installation.

## Further grant warm-up checks on 23 October

Source: `63e519a8b251c2919b953d01af2e377df3fb8901`.
The branch was fetched and rebased onto `f377da0af`, then onto `289462570` after
main gained documentation. Both rebases finished. The second update changed only
the accepted memory design and its release note.

### The preparation gap and its proof

The old helper finished the model grant summary and waited for the latest Alice
and assistant OpenFGA receipts. It did not finish the first reads of the small
ownership, member and assistant histories. Those reads still started inside the
HTTP warm-up's two-second budget.

A diagnostic captured a NATS timeout in the assistant-history read in `context`
during the separate 10,000-member case. The long-grant warm-up uses the same read
path. A new regression first confirms both model permissions are allowed. It then
delays only the first assistant-history lookup by 2,200 ms. With grant preparation
alone, HTTP warm-up returns 403 instead of 200. This also fails after all temporary
production logging is removed.

Expected FAIL: test-first commit `90c324d0c`. PASS after fix `63e519a8b`: the renamed
`prepareDecisionWarmUp` finishes the first reads of `ownership-test`, `member-alice`
and `assistant-assistant` under the existing preparation deadline. The HTTP call
still reads current access again with a fresh two-second deadline. No prepared
access decision or old positions are trusted by that call.

PASS: the delayed-read regression, receipt regression, expired-token regression,
3,000-grant case and 15,000-edit case passed together after the fix. The new
regression requires 200, one unsettled reservation and no provider call. The two
long-grant cases retain their original 200 responses, reservation checks, zero
old grant rows and less-than-two-second assertion. The 15,000-edit and
10,000-member input sizes are unchanged. No admission is retried.

Logs are `/tmp/ci-flakes-3-fix2-authority-red.log`, `authority-red-clean.log` and
`authority-green.log`, with the green JSON report beside them.

The earlier natural 3,000-grant warm-up refusal was not reproduced in this round's
baseline diagnostics. The controlled delay proves a remaining preparation gap;
it does not establish the internal reason for that earlier recorded request.
Production files, permission checks and deadlines are unchanged by this fix.

### Which grants are applied

The fixture uses manual grants. It awaits the OpenFGA handler for Alice and the
assistant before returning the fixture. Each handler write saves its permission
tuple and receipt together. A tuple is OpenFGA's stored permission relationship.
The decision path does not read a SQL grants checkpoint.

The synthetic grants are added only to NATS after background event delivery
stops. Their permissions for other members are deliberately never applied to
OpenFGA. Waiting for every synthetic grant receipt would stall these tests.
`prepareDecisionWarmUp` waits for the model grant summary and the latest Alice and
assistant receipts before completing the three small history reads above.

### Consecutive runs after the fix

All twenty full-file runs used the committed test code above, without temporary
production or test diagnostics. Each command used `nice -n 10` and three workers.
Runs 1 and 2 included both changed test files and child recovery. Runs 3–20 used
decision fence and child recovery as the two load companions. The normal fixtures
started their own NATS, OpenFGA and gateway services.

All runs set `PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:55463/postgres`.
The disposable `pgtest-ci-flakes-3-fix2` database passed `pg_isready` before tests.
This is the development worktree, not a fresh installation. The parent had nice
value 10, so commands started with another `nice -n 10` ran at 19. A separate
process at the same priority used 10 ms of CPU and slept for 20 ms throughout. Full
lint and typecheck overlapped the first two batches. Other shared-host work continued.

The command for runs 1 and 2 was:

```sh
PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:55463/postgres \
  nice -n 10 npx vitest run \
  libs/models/test/decision-cost.test.ts \
  apps/server/test/memory.test.ts \
  apps/server/test/child-recovery.test.ts --maxWorkers=3 \
  --reporter=default --reporter=json \
  --outputFile=/tmp/ci-flakes-3-fix2-fixed-repeat-01.json
```

Runs 3–20 replaced `memory.test.ts` with
`libs/models/test/decision-fence.test.ts`. Each run used its own numbered JSON and
text log. There were no test-name filters, skipped tests or retries within a run.
All twenty runs finished on the same committed test code.

The numbers beside FAIL are failed-case counts. The two measurement columns are
milliseconds for the measured admission, after successful HTTP warm-up.

| Run | Decision cost, 28 | 3,000 grants, ms | 15,000 edits, ms | Memory, 241 | Decision fence, 75 | Child recovery, 36 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | FAIL (2) | 1226 | 422 | FAIL (3) | NOT RUN | PASS |
| 2 | FAIL (2) | 658 | 308 | FAIL (1) | NOT RUN | PASS |
| 3 | PASS | 701 | 135 | NOT RUN | PASS | PASS |
| 4 | PASS | 567 | 107 | NOT RUN | PASS | PASS |
| 5 | FAIL (1) | 620 | 152 | NOT RUN | PASS | PASS |
| 6 | PASS | 479 | 91 | NOT RUN | PASS | PASS |
| 7 | PASS | 430 | 103 | NOT RUN | PASS | PASS |
| 8 | PASS | 725 | 116 | NOT RUN | PASS | PASS |
| 9 | FAIL (1) | 486 | 149 | NOT RUN | PASS | PASS |
| 10 | PASS | 463 | 81 | NOT RUN | PASS | PASS |
| 11 | PASS | 453 | 73 | NOT RUN | PASS | PASS |
| 12 | PASS | 622 | 153 | NOT RUN | PASS | PASS |
| 13 | PASS | 675 | 84 | NOT RUN | PASS | PASS |
| 14 | PASS | 662 | 123 | NOT RUN | PASS | PASS |
| 15 | PASS | 382 | 121 | NOT RUN | PASS | PASS |
| 16 | PASS | 651 | 151 | NOT RUN | PASS | PASS |
| 17 | PASS | 538 | 106 | NOT RUN | PASS | PASS |
| 18 | FAIL (1) | 342 | 73 | NOT RUN | PASS | PASS |
| 19 | FAIL (1) | 471 | 130 | NOT RUN | PASS | PASS |
| 20 | PASS | 582 | 95 | NOT RUN | PASS | PASS |

- PASS: the delayed-read, grant-receipt and expired-token regressions each passed 20/20.
- PASS: the 3,000-grant and 15,000-edit cases each passed 20/20.
- PASS: the measured 3,000-grant calls took 342–1226 ms.
- PASS: the measured 15,000-edit calls took 73–422 ms.
- FAIL: complete decision-cost files passed 14/20.
- FAIL: the 10,000-member case passed 15/20; its input size was kept.
- FAIL: the cold-chat catch-up case passed 18/20.
- FAIL: complete memory files passed 0/2.
- PASS: both correction races and the occupied-slot conflict case passed in both memory runs, six case executions in total.
- PASS: decision fence passed 18/18 and child recovery passed 20/20.

Every failed case is retained below. None is counted as a passing run.

| File | Failed case | Runs |
| --- | --- | --- |
| memory.test.ts | omits a pinned fact after its previously live dependency becomes missing | 1 |
| memory.test.ts | rebuilds binding status without any key, model, tool, computer or scheduler port | 1, 2 |
| memory.test.ts | checks the original command after an accepted append loses its reply | 1 |
| decision-cost.test.ts | lets a cold models process catch up and then admits using only the chat tail | 1, 2 |
| decision-cost.test.ts | keeps 10,000 members on one model and eight models with 1,000 members cached in one process | 1, 2, 5, 9, 19 |
| decision-cost.test.ts | refuses a fresh computer.suspended from opencrane-server after warming the summaries | 18 |

Run 18's computer-suspension case reached its existing 40-second test timeout.
Its refusal assertion did not complete, so it is not a pass for that condition.
The other failed cases above are unchanged by this fixture fix. Complete-file
qualification remains PARTIAL, despite the affected long-grant cases passing.

Reports are `/tmp/ci-flakes-3-fix2-fixed-repeat-01.json` through
`fixed-repeat-20.json`, with matching `.log` files. The summary is
`/tmp/ci-flakes-3-fix2-fixed-results.json`.

### Final rebase after qualification

Main advanced while the twenty runs were in progress. A `git fetch origin`
and rebase onto `bdd78f557` completed after qualification. A further fetch and
rebase onto `62c404b3a` also finished when main gained more demo tooling. These
updates added demo tools and an unselected upload test, with documentation and
workflow steps.
The compared 1,660 source files were unchanged. This includes the affected test
files, libraries, server runtime and fixture helpers, package files, lockfile,
Vitest configuration and scripts, including gateway fetch scripts. The timing
results above therefore describe the same test and runtime code after this rebase.

The test-first commit is now `b8ae1d585` (tested as `90c324d0c`), and the fix is now
`95da00838` (tested as `63e519a8b`). Each pair has the same decision-cost test blob.
The comparison is saved in `/tmp/ci-flakes-3-fix2-final-rebase-proof.json`.

### Final checks and cleanup

PASS: full lint, full typecheck, event catalogue agreement (149 types), separate
Knip and changelog lint on the fix commit. Full lint reported zero errors and
24 existing warnings. It used `NODE_OPTIONS=--max-old-space-size=6144`.
All checks and tests ran under `nice -n 10`.

PASS after the rebase onto `bdd78f557`: full lint, full typecheck, event catalogue
agreement (149 types), separate Knip and changelog lint. Full lint again reported zero
errors and 24 warnings. Its Markdown and link checks also passed: 281 files and
1,971 links, with zero errors. These refreshed logs use
`/tmp/ci-flakes-3-fix2-rebased-` with the same five check endings below.

PASS after the last rebase onto `62c404b3a`: full lint, full typecheck, event
catalogue agreement, separate Knip and changelog lint. Lint reported zero errors
and 24 warnings; its Markdown and link checks passed again. These logs use
`/tmp/ci-flakes-3-fix2-latest-` with the same five check endings below.

The first instrumented lint attempt failed on three unnecessary temporary lint
comments. They were removed before the successful rerun. The final checks above
used the committed code without any temporary production or test diagnostics.

Final check logs use `/tmp/ci-flakes-3-fix2-final-` with `lint`, `typecheck`,
`events`, `knip` and `changelog` endings. The test-first logs above retain both the
expected failing result and the passing result after the fix.

PASS: the load process stopped after the last batch. The disposable PostgreSQL
container and its volumes were removed with
`docker rm -f -v pgtest-ci-flakes-3-fix2`.

NOT RUN: full root suite and fresh-install journeys. CI was not awaited. The PR
remains draft.

### Baseline diagnostics before the fix

The baseline used the same assertions and input sizes, with temporary refusal and
warm-up timing logs. All fourteen full-file runs finished. None was cancelled.
The 3,000-grant and 15,000-edit cases passed 14/14; these baseline runs do not replace
the twenty runs on the fix above.

| Run | Decision cost, 27 | Memory, 241 | Decision fence, 75 | Child recovery, 36 |
| --- | --- | --- | --- | --- |
| 1 | FAIL (1) | FAIL (1) | NOT RUN | PASS |
| 2 | PASS | PASS | NOT RUN | PASS |
| 3 | PASS | PASS | NOT RUN | PASS |
| 4 | PASS | NOT RUN | PASS | PASS |
| 5 | PASS | NOT RUN | PASS | PASS |
| 6 | PASS | NOT RUN | PASS | PASS |
| 7 | PASS | NOT RUN | PASS | PASS |
| 8 | PASS | NOT RUN | PASS | PASS |
| 9 | FAIL (1) | NOT RUN | PASS | PASS |
| 10 | PASS | NOT RUN | PASS | PASS |
| 11 | FAIL (1) | NOT RUN | PASS | PASS |
| 12 | PASS | NOT RUN | PASS | PASS |
| 13 | FAIL (2) | NOT RUN | PASS | PASS |
| 14 | PASS | NOT RUN | PASS | PASS |

Baseline failures are retained:

- Decision cost: the 10,000-member case failed in runs 1, 11 and 13. The cold-chat
  catch-up case failed in runs 9 and 13.
- Memory: the supporting-key preview case failed in run 1.
- Decision fence and child recovery passed every time they ran.

Reports are `/tmp/ci-flakes-3-fix2-trace-01.json` through `trace-14.json`, with
matching `.log` files. The summary is `/tmp/ci-flakes-3-fix2-trace-results.json`.

Two earlier full diagnostic batches also used memory and child recovery as
companions. Both passed the 3,000-grant and 15,000-edit cases but failed the
10,000-member case. The first memory run passed 241/241; the second failed its
binding-status rebuild case. Child recovery passed 36/36 in both. Their logs use
`/tmp/ci-flakes-3-fix2-diagnostic` and `diagnostic2`, with `.log` and `.json` endings.

PASS: thirty extra focused runs of the original 3,000-grant case. The other cases
were excluded by their test names in these diagnostics. They do not replace any
full-file run. Logs use `/tmp/ci-flakes-3-fix2-focused-01.log` through `focused-30.log`.

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
