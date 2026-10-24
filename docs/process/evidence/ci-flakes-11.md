# Approval retry during a competing refusal

## Pre-publish expiry correction, 24 October 2026

The store now distinguishes a refusal before any publish from an uncertain write.
`unavailable.notPublished: true` means that this invocation never started sending
an event to NATS. The flag stays absent once any publish starts, including all
later retries in that invocation. It cannot establish what happened in an earlier
invocation with the same command id.

The budget actor refuses a proven unpublished append without setting `failed`.
It handles the first append and every repeated append in the same place. A lost
reply still stops the writer. No deadline, conditional publish, permission, money
or memory check was removed or relaxed.

The final fetched base is `950f960080342c3fa3b4320bdd70fb414bfa2bdc`.
All rebases completed without conflicts, and the fetched base is an ancestor of the branch. The two complete
selected-suite runs and load batch preceded the last scanner-token rebase. The
budget and event-store source and selected test files were unchanged by main's
updates. The final base has its own auth tests and two additional complete runs
of the changed actor and append files.

The regression test commit is `fcc7984b4`; the behaviour fix follows in `25f03967a`.
The invalid-input check in `f275e8db9` records existing correct behaviour. Later
commits tighten the new error assertions and move the unchanged reservation guard
into the existing budget-refusal module. No check was removed to meet a lint limit.

### Own failing-first evidence and early exits

The real-NATS regression inserts unrelated member events in access callbacks two
and four. Callback six passes just before the original two-second deadline, then
the store sees expiry before its next publish. Before the fix, the next reservation
fails with `Budget writer unavailable`, although no admission was saved.
The first-publish expiry and store-side access refusal cases fail the same way.
The initial log is `actor-red.log`; the four-case result is
`actor-boundaries-red.log`. Four store assertions also fail before the change
because the result lacks proof that no publish began (`store-red.log`).

The retained lost-reply cases save the third conditional publish but hide its
reply. The following access check either expires or refuses permission. Both
cases require exactly one saved admission and a stopped writer. They pass before
and after the correction. The invalid-input test also passes before the change;
it confirms that event validation already refuses a bad request without stopping
later valid reservations. The final tests check the exact refusal messages.

The early-exit inspection covered event validation, both switch-on guards,
conflict reads, refusal to repeat without an access callback, the callback itself,
the actor's post-callback deadline check, initial and repeated store results, and
foreign or changed budget rows. Local refusals already leave the writer usable.
Foreign rows and another budget writer still set `failed`; unavailable replies
without non-publication proof still do so. No broader recovery was added.

### Test setup

All test invocations, lint and typecheck use `nice -n 10`. Each Vitest process has
one worker. The two complete selected-suite passes overlap the 30-run approval
batch. Each approval iteration runs both saved-start and budget-admission recovery
cases. A temporary Vitest configuration enables private warning logs and leaves
all test limits and assertions unchanged.

Focused failing-first runs use the supplied `PG_TEST_URL` on port 55432.
The complete suites and load batch use the throwaway
`pgtest-ci-flakes-11-expiry` database on port 34372, after `pg_isready` succeeds.
NATS, OpenFGA and gateway fixtures start their normal isolated services. The owner
stack and Docker daemon settings are untouched.

Logs and JSON reports for this correction are in `/tmp/ci-flakes-11-expiry/`.
Earlier failures below remain recorded. A later passing run does not establish
the cause of an earlier failure or prove it fixed.

### Complete selected-suite results

Both runs completed all 14 selected files. Each has 506 passed, four failed and
one optional browser case NOT RUN. Overall qualification is PARTIAL.
The full-run results are FAIL; passing reruns do not replace them.

| File | First run | Second run |
| --- | --- | --- |
| `apps/server/test/approvals.test.ts` | PASS: 74 passed, 1 NOT RUN | FAIL: 73 passed, 1 failed, 1 NOT RUN |
| `apps/server/test/integration-access-gateway.test.ts` | PASS: 17 passed | PASS: 17 passed |
| `libs/event-store/test/append.test.ts` | PASS: 24 passed | PASS: 24 passed |
| `libs/event-store/test/history-checked.test.ts` | PASS: 17 passed | PASS: 17 passed |
| `libs/event-store/test/read-retry.test.ts` | PASS: 12 passed | PASS: 12 passed |
| `libs/models/test/actor.test.ts` | PASS: 47 passed | PASS: 47 passed |
| `libs/models/test/approval-cancellation.test.ts` | PASS: 13 passed | PASS: 13 passed |
| `libs/models/test/approval-record.test.ts` | PASS: 5 passed | PASS: 5 passed |
| `libs/models/test/decision-activity.test.ts` | PASS: 12 passed | PASS: 12 passed |
| `libs/models/test/decision-cost.test.ts` | FAIL: 25 passed, 3 failed | FAIL: 26 passed, 2 failed |
| `libs/models/test/decision-fence.test.ts` | PASS: 75 passed | FAIL: 74 passed, 1 failed |
| `libs/models/test/decision-grants.test.ts` | PASS: 3 passed | PASS: 3 passed |
| `libs/models/test/decision-refusal.test.ts` | PASS: 1 passed | PASS: 1 passed |
| `libs/models/test/mcp-dispatch.test.ts` | FAIL: 181 passed, 1 failed | PASS: 182 passed |

### Retained failures and focused reruns

- First run: the stopped-Ask case and expired fixture-token warm-up each exceeded
  30 seconds. Both focused reruns passed. The original timeout causes remain unknown.
- First run: the team-revocation case failed during fixture membership setup with
  an OpenFGA one-second timeout. Its focused rerun passed.
- First run: the 10,000-member case returned 403 instead of 200. Its diagnostic
  rerun failed again. The fixed diagnostic label was `event_store_unavailable` at
  `access_and_budget`, after 2,625 ms. This does not identify the underlying cause
  or establish healthy performance under load.
- Second run: the approval-expiry case failed with NATS `heartbeats missed`.
  Its focused rerun passed; the original failure remains recorded.
- Second run: the harmless MCP activity case failed while creating its fixture
  OpenFGA store, with a one-second timeout. Its focused rerun passed.
- Second run: the cold-process case failed with a bounded event-read timeout.
  Its focused rerun passed.
- Second run: the large-grant case timed out while seeding NATS events, before
  the measured decisions. This differs from the first run and diagnostic rerun.

Focused reruns therefore have six passing cases and one failing case. The large-grant
failure is still unresolved. No assertion, timeout or access check was loosened.

### Load batch and final-base checks

- PASS: all 30 approval-retry iterations, with both recovery cases in each run
  (60/60 cases). Each iteration overlapped at least one selected-suite process.
- PASS: after the final rebase, actor and event-store append tests passed 71/71
  twice. This includes the exact retry-publication boundary and lost-reply cases.
- PASS: all 195 auth tests after the scanner-token update on main.
- NOT RUN: the full root suite, fresh-install journeys and optional approval browser case.

The throwaway PostgreSQL container was removed with `docker rm -f -v` after testing.
The owner stack and Docker daemon settings were untouched.

### Static checks

The first full lint run failed on the actor file's line count and a test callback
marked async without an await. Both were corrected without changing assertions.
Final checks on the scanner-token base:

- PASS: full lint, including Knip, dependency rules, docs, links, fixtures and licences.
  ESLint reports 25 warnings and no errors.
- PASS: repository-wide typecheck.
- PASS: `check:events`, with 153 event types matching the catalogue.
- PASS: `npm run lint:changelog` and the evidence document's Markdown check.

The final lint process has a 6 GiB JavaScript heap limit; test limits are unchanged.
All commands retain `nice -n 10`. CI is not awaited and the PR remains draft.

## Earlier product correction, 24 October 2026

The branch was fetched and rebased onto `origin/main`. The rebases completed without
conflicts. The final base is `e3b79fc6b9504c9c136ddd9b1c57e7eed3dd2288`. Main added
the unrelated custody fixture and child-chat change during testing. Neither rebase
changed this correction’s product files or the selected test files. The earlier
investigation below is retained as history; its unexplained
refusals are not reclassified as timing failures.

Two unrelated member writes can interrupt consecutive conditional budget publishes.
The first correction below only retried once. The current actor checks the budget
after every conflict and reruns the original access check before publishing again.
It passes the original deadline to conflict reads and checked publishes. It keeps
one event id and the global publish condition. A changed budget still stops the old
writer. An unrelated conflict alone does not permanently disable it.

HTTPS dispatch now records its attempt before budget admission. A refused admission
can close that confirmed attempt with trusted proof that nothing was sent. Approval
recovery uses this saved proof, rechecks permission, and allows one replacement use.
It never infers non-dispatch from a generic 403. Lost start replies stay uncertain.
Private warnings record only the saved request id, fixed stage and reason labels,
and elapsed milliseconds. The label `budget_write_refused` does not guess whether
another writer or an unavailable append caused the refusal.

### Earlier failing-first checks

- `34d339cd3` commits the real-NATS, two-conflict actor cases before `fd78b80a2`.
  FAIL before the fix: unchanged access was refused and the original deadline was
  missing from conflict operations. PASS after the fix: eight conflict cases,
  including expiry, revocation, changed budget and continued writer use.
- `1ce232545` commits the pre-admission HTTP recovery case before `191e61d36`.
  FAIL before the fix: consumed approval had `canRetry: false` after a refusal
  with no remote connection. PASS after the fix: both recovery cases send once,
  refuse the competing retry, keep two approval uses and reserve no money.
- `4e2184dcb` commits the private diagnostic cases before `9e9a3b7e1`.
  FAIL before the fix: dispatch refusals had no diagnostic. PASS after the fix:
  fixed labels and elapsed time are present; private canaries, permits and stacks
  are absent. `92c0b501c` first requires an accurate budget-refusal label, followed
  by `dc2b70d36`. Both diagnostic cases then pass twice.

Initial logs are `/tmp/ci-flakes-11-{actor,approval,diagnostics}-{red,green}.log`.
Later logs and JSON reports are in `/tmp/ci-flakes-11-followup/`.
The first focused lint found complexity and an untyped test value. Those were fixed.
The first full lint had already read the earlier function and reported its complexity;
that result remains FAIL. The subsequent lint uses the corrected source.

### Earlier test setup

Tests run at `nice -n 10`, with one worker per Vitest invocation and no root suite.
Initial focused checks use the supplied test database on port 55432. Full checks
and the stress batch use the throwaway `pgtest-ci-flakes-11-followup` database on
port 33966, with `pg_isready` checked before use. Fixtures create their own NATS,
OpenFGA, gateway and HTTPS services. No owner stack or Docker daemon settings changed.

Each stress invocation runs both approval recovery cases. The two focused-suite
passes run alongside the batch to provide load. The stress-only temporary Vitest
configuration enables private warning logs and changes no test or deadline.

### Earlier verification results

Both complete invocations use the same eleven selected files and one worker.
The original failures below stay recorded even where a focused rerun passes.

| File | First pass | Second pass |
| --- | --- | --- |
| `apps/server/test/approvals.test.ts` | PASS: 67 passed, 1 NOT RUN | PASS: 67 passed, 1 NOT RUN |
| `apps/server/test/integration-access-gateway.test.ts` | PASS: 17 passed | FAIL: 16 passed, 1 failed |
| `libs/models/test/actor.test.ts` | PASS: 40 passed | PASS: 40 passed |
| `libs/models/test/approval-cancellation.test.ts` | PASS: 13 passed | PASS: 13 passed |
| `libs/models/test/approval-record.test.ts` | PASS: 5 passed | PASS: 5 passed |
| `libs/models/test/decision-activity.test.ts` | PASS: 12 passed | PASS: 12 passed |
| `libs/models/test/decision-cost.test.ts` | FAIL: 27 passed, 1 failed | PASS: 28 passed |
| `libs/models/test/decision-fence.test.ts` | PASS: 75 passed | PASS: 75 passed |
| `libs/models/test/decision-grants.test.ts` | PASS: 3 passed | PASS: 3 passed |
| `libs/models/test/decision-refusal.test.ts` | FAIL: 0 passed, 1 failed | PASS: 1 passed |
| `libs/models/test/mcp-dispatch.test.ts` | PASS: 182 passed | FAIL: 181 passed, 1 failed |

The optional `APPROVAL_BROWSER=1` case is NOT RUN in both passes.
The full root suite and fresh-install journeys are NOT RUN.

| Own static check | Result |
| --- | --- |
| Full lint, including Knip, dependency rules, docs, links and licences | PASS; 25 ESLint warnings, no errors |
| Repository-wide typecheck after the final rebase | PASS |
| Event catalogue after the final rebase | PASS; 153 types |
| Changelog validation after the final rebase | PASS |
| Markdown after the final rebase | PASS |

Full lint passed before the later rebases. They add main’s custody fixture and
child-chat change, leaving this correction’s product files and selected tests
unchanged. Post-rebase checks passed. Focused ESLint also passed for all changed
TypeScript files and the final readability changes.
The final diagnostic label was checked twice separately after its wording change.

### Earlier stress invocations

Each row runs both approval cases alongside the selected suites. All calls keep
the original two-second access deadline. No failed run is replaced by a rerun.
The first batch changes its injection point after run 28. Every final-batch run
uses the corrected fixture, which pauses IAM at the public admission method and
then calls the real method. All assertions remain unchanged.

| Run | First batch | Seconds | Final batch | Seconds |
| --- | --- | --- | --- | --- |
| 1 | PASS | 60 | FAIL | 60 |
| 2 | PASS | 62 | PASS | 48 |
| 3 | PASS | 63 | PASS | 44 |
| 4 | PASS | 57 | PASS | 49 |
| 5 | PASS | 58 | PASS | 46 |
| 6 | PASS | 55 | PASS | 37 |
| 7 | PASS | 48 | PASS | 40 |
| 8 | PASS | 39 | PASS | 41 |
| 9 | PASS | 40 | PASS | 35 |
| 10 | PASS | 36 | PASS | 33 |
| 11 | PASS | 33 | PASS | 40 |
| 12 | PASS | 33 | PASS | 40 |
| 13 | PASS | 32 | PASS | 50 |
| 14 | PASS | 39 | PASS | 49 |
| 15 | PASS | 37 | PASS | 41 |
| 16 | PASS | 35 | PASS | 41 |
| 17 | PASS | 40 | PASS | 45 |
| 18 | PASS | 37 | PASS | 49 |
| 19 | PASS | 42 | PASS | 48 |
| 20 | PASS | 45 | PASS | 50 |
| 21 | PASS | 47 | PASS | 45 |
| 22 | PASS | 47 | PASS | 39 |
| 23 | PASS | 58 | PASS | 34 |
| 24 | PASS | 59 | PASS | 33 |
| 25 | PASS | 60 | PASS | 34 |
| 26 | FAIL | 66 | PASS | 34 |
| 27 | FAIL | 74 | PASS | 39 |
| 28 | PASS | 71 | PASS | 34 |
| 29 | PASS | 70 | PASS | 33 |
| 30 | PASS | 52 | PASS | 33 |

The first batch is FAIL: 28/30 complete runs, with 58/60 individual cases passing.
The final batch is FAIL: 29/30 complete runs, with 59/60 individual cases passing.
The new pre-admission recovery case passes 30/30 in the final batch. The original
saved-start case passes 29/30. These results make overall qualification PARTIAL.

The focused generation diagnostic passes both cases. The separate diagnostic
rerun of the large-grant and resumed-token cases also passes both cases. These
reruns do not erase the original failures or establish every original cause.

Logs and JSON reports are `/tmp/ci-flakes-11-followup/pass{1,2}.{log,json}`,
`stress-{1..30}.{log,json}`, `final-stress-{1..30}.{log,json}`,
`generation-diagnostic.{log,json}` and `decision-diagnostic.{log,json}`.
Static logs are in the same folder. The throwaway PostgreSQL container was removed
with its volume after the tests. No extra load-only suite was needed: the selected
suites overlapped every stress invocation. CI is not awaited.

### Earlier failures and what is known

- First full pass: the 10,000-member decision-cost case returned 503 with
  `Decision audit unavailable`. Its focused diagnostic rerun passed. The original
  audit failure's underlying cause remains unresolved.
- First full pass: the resumed-token case returned gateway 401 with
  `InvalidSignature` before the model decision. Its focused rerun and second full
  pass passed. The original signature failure's underlying cause remains unresolved.
- Second full pass: the changed-generation case failed while its publication fixture
  waited for a witness: 404 instead of 200. It had not reached the changed-generation
  refusal. Both generation cases passed in the focused diagnostic rerun.
- Second full pass: the zero-delay tool-history case exceeded the existing 30-second
  cleanup hook limit in `setup.close`. Its focused rerun passed. No hook limit or
  assertion was increased.
- First stress batch, run 26: the new fixture paused IAM during the earlier decision.
  That decision returned 503 before the intended budget admission. Its private log
  records `event_store_unavailable` in `access_and_budget` after 2,436 ms. The fixture
  now pauses at the public `admitDispatch` method, then invokes the real method.
- First stress batch, run 27: the original saved-start case took 2,510.65 ms against
  its unchanged 2,000 ms response assertion. The private refusal records
  `access_deadline_expired` in `budget_admission` after 2,473 ms.
- Final stress batch, run 1: the original case returned `[403, 403]`. The permitted
  retry's private refusal records `access_deadline_expired` in `final_access`,
  675 ms after dispatch began. The original shared deadline was not extended.
  This identifies this run's refusal; it does not explain earlier historical runs.

## Earlier investigation

Everything below records the earlier source and its own results.

## Cause

The reported failure in [main run 40104402066](https://github.com/elewa-git/opencrane-new/actions/runs/40104402066)
returned two 403 replies where the approval retry test expected one 200 and one 403.
The existing configuration-probe fix removed one source of unrelated writes, but a
competing call's saved refusal can cause the same conflict. The merged production
diff only filtered configuration probes. It left the approval recovery case unchanged
and preserved the shared two-second request budget.

A budget append captures the global event position before checking access. If the
competing refusal saves during that check, the conditional publish returns conflict.
The budget actor previously treated that result as another budget writer taking over,
even when its budget stream had not changed. It stopped the writer after the retry
had already consumed the approval. IAM health and grant receipts do not prevent this
ordering. The CI logs do not contain the private dispatch cause; the controlled test
below reproduces this concrete product defect and the exact HTTP failure.

## Failing-first proof

Test commit `0620d7be1c9a91753f90a01f4c8e5dd9af8e15a3` precedes the product change.
The integration test holds the competing refusal until the budget append starts its
access check. It then saves that refusal before returning from the check. Real NATS
returns conflict for `budget.call_dispatch_admitted`, and both HTTP replies are 403.
The test expects one send and fails. No sleep or HTTP retry arranges the overlap.

The actor tests also use real NATS. Before the fix, unchanged access fails with
`Budget writer lost its fence`. Revocation and expiry fail with that same premature
error rather than reaching the original access check again. Another budget writer
is already refused correctly. Reports: `/tmp/ci-flakes-11/integration-red.json` and
`/tmp/ci-flakes-11/actor-red.json`.

Ten baseline repetitions of the existing approval test passed alongside a full
75-test decision-budget run. Vitest reports the repeated case as one aggregate
result. These passes do not rule out the controlled ordering above. An earlier
diagnostic held the wrong outcome label and timed out; that harness error is not
used as product failure evidence.

## Correction

Product source: `869da8a455ee70ebdad791240e9b75b6783950be`, based on main
`8f3b2e8a8`. After a conflict, the actor reads later budget events. An unchanged
budget permits one more append only when the caller supplied an access check.
The same check runs before and inside that append. Its original access deadline,
event id, expected budget position and global publish condition remain in force.
Another budget writer or a second conflict still stops the writer. Existing recovery
for managed-provider switch-on is preserved.

The focused corrected-source check passed all five cases. The integration case sends
once, refuses the competing call, retains two approval uses including the earlier
unsent start, and reserves no money. Actor cases retain refusals for revoked access,
expiry at 2,001 ms and another budget writer.

## Setup and qualification limits

Node 22.23.3; clean `npm ci`; links to the shared pinned NATS and Lychee binaries.
The disposable PostgreSQL container is `pgtest-ci-flakes-11`, using port 33342 and
`PG_TEST_URL=postgres://postgres:test-only@127.0.0.1:33342/postgres`.
Tests create private databases, NATS, OpenFGA and gateway fixtures. Every test and
static check runs under `nice -n 10`. The 30 full-file invocations each use one worker
and no file parallelism. A separate process repeatedly runs the unchanged 75-test
`decision-fence.test.ts` alongside them, also with one worker.

The owner stack, access checks, two-second budgets, authority tests and security rules
are unchanged. No dependency or event/API field was added. The full root suite and
fresh-install journeys are NOT RUN. This is source verification, not live qualification.

## Every full-file result

FAIL: 25 of 30 complete invocations passed. The original IAM recovery case passed
30/30. An extra controlled HTTP case passed 28/30. Every original test was present
in each invocation. These results are not a clean qualification of the whole file.

The batch used product source `869da8a45` and the extra HTTP diagnostic from the
failing-first commit. The final branch retains the real-NATS actor regression and
removes that duplicate HTTP outage scenario. Its original integration test file is
unchanged. No original assertion or two-second limit was removed.

| Run | Whole file | Original retry | Extra HTTP case | Seconds |
| --- | --- | --- | --- | --- |
| 1 | PASS 17/17 | PASS | PASS | 260.38 |
| 2 | PASS 17/17 | PASS | PASS | 242.68 |
| 3 | FAIL 14/17 | PASS | PASS | 248.89 |
| 4 | PASS 17/17 | PASS | PASS | 187.28 |
| 5 | FAIL 16/17 | PASS | PASS | 175.44 |
| 6 | PASS 17/17 | PASS | PASS | 157.25 |
| 7 | PASS 17/17 | PASS | PASS | 201.92 |
| 8 | PASS 17/17 | PASS | PASS | 217.86 |
| 9 | PASS 17/17 | PASS | PASS | 182.91 |
| 10 | PASS 17/17 | PASS | PASS | 175.19 |
| 11 | PASS 17/17 | PASS | PASS | 194.00 |
| 12 | FAIL 16/17 | PASS | FAIL | 237.11 |
| 13 | PASS 17/17 | PASS | PASS | 206.77 |
| 14 | PASS 17/17 | PASS | PASS | 171.97 |
| 15 | PASS 17/17 | PASS | PASS | 164.61 |
| 16 | PASS 17/17 | PASS | PASS | 195.85 |
| 17 | PASS 17/17 | PASS | PASS | 195.48 |
| 18 | PASS 17/17 | PASS | PASS | 203.30 |
| 19 | PASS 17/17 | PASS | PASS | 178.19 |
| 20 | PASS 17/17 | PASS | PASS | 185.18 |
| 21 | PASS 17/17 | PASS | PASS | 196.93 |
| 22 | PASS 17/17 | PASS | PASS | 276.14 |
| 23 | PASS 17/17 | PASS | PASS | 232.42 |
| 24 | PASS 17/17 | PASS | PASS | 155.73 |
| 25 | PASS 17/17 | PASS | PASS | 215.86 |
| 26 | PASS 17/17 | PASS | PASS | 262.70 |
| 27 | FAIL 16/17 | PASS | FAIL | 249.68 |
| 28 | FAIL 16/17 | PASS | PASS | 272.16 |
| 29 | PASS 17/17 | PASS | PASS | 240.67 |
| 30 | PASS 17/17 | PASS | PASS | 263.80 |

### Remaining failures

- Run 3: publication returned unavailable during the membership-removal fixture;
  the unchanged-refresh case missed NATS heartbeats; the IAM outage response took
  4.10 seconds against its existing two-second assertion. Both retry cases passed.
- Run 5: the first grant-side case failed fixture publication with
  `Gateway delivery unavailable`. Both retry cases passed.
- Run 12: the extra HTTP case took 2.32 seconds against the earlier IAM refusal's
  two-second assertion. It failed before the controlled budget overlap.
- Run 27: the extra HTTP case returned `[403, 403]`. Its private refusal cause was
  not recorded. This repeated symptom remains unexplained and remains FAIL.
- Run 28: the direct-grant case saved Allow and a tool start, then saved
  `not_dispatched` with `adapter_dispatch_refused`. Its private cause was not
  recorded. Both retry cases passed.

The host was paging memory during run 3 while my full typed lint was also running.
I stopped that lint process to release about 3.6 GB and left the two test processes
running. That observation does not prove the cause of every failure above. No failed
run was replaced by a passing rerun. Logs and JSON reports are
`/tmp/ci-flakes-11/stress-{01..30}.{log,json}`.

## Companion results

Each row is a separate full invocation of the unchanged
`libs/models/test/decision-fence.test.ts`, alongside the integration batch.

| Run | Result | Seconds |
| --- | --- | --- |
| 1 | PASS 75/75 | 333.52 |
| 2 | PASS 75/75 | 358.34 |
| 3 | PASS 75/75 | 250.99 |
| 4 | PASS 75/75 | 222.43 |
| 5 | PASS 75/75 | 250.16 |
| 6 | PASS 75/75 | 281.82 |
| 7 | PASS 75/75 | 227.58 |
| 8 | PASS 75/75 | 261.60 |
| 9 | PASS 75/75 | 302.25 |
| 10 | PASS 75/75 | 266.98 |
| 11 | PASS 75/75 | 223.32 |
| 12 | PASS 75/75 | 249.46 |
| 13 | PASS 75/75 | 267.28 |
| 14 | PASS 75/75 | 241.52 |
| 15 | PASS 75/75 | 255.12 |
| 16 | PASS 75/75 | 296.51 |
| 17 | PASS 75/75 | 343.90 |
| 18 | PASS 75/75 | 220.78 |
| 19 | PASS 75/75 | 301.24 |
| 20 | PASS 75/75 | 338.68 |
| 21 | PASS 75/75 | 346.67 |
| 22 | PASS 75/75 | 340.33 |
| 23 | PASS 75/75 | 268.95 |

Reports: `/tmp/ci-flakes-11/load-{01..23}.{log,json}`.

## Additional private diagnostics

Thirty focused repetitions of the extra HTTP case passed, alongside two further
75-test decision-budget runs. Temporary code logged only fixed refusal labels,
append status and elapsed time. It recorded 30 forced first-append conflicts and
30 successful second appends. It did not reproduce run 27 or establish its cause.
The source files were restored byte for byte and the temporary configuration was
removed before final checks. Reports and logs are
`/tmp/ci-flakes-11/diagnostic-retry.{log,json}` and
`/tmp/ci-flakes-11/diagnostic-load-{1,2}.{log,json}`.

The permanent regression stays at `BudgetActor.admitDispatch`, using real NATS.
It forces the same global-position change without duplicating the existing HTTP
outage fixture. The failing-first actor check and its access, expiry and other-writer
refusals remain. The removed diagnostic remains visible in the test commit.

## Final own checks

| Check | Result |
| --- | --- |
| Actor tests after cleanup fix, first pass | PASS: 36/36 |
| Original integration file, first pass | PASS: 16/16 |
| Event security rules | PASS: 438/438 |
| Actor tests after cleanup fix, second pass | PASS: 36/36 |
| Original integration file, second pass | PASS: 16/16 |
| Typecheck | PASS |
| Event catalogue | PASS |
| Knip | PASS |
| Changelog validation | PASS |
| Full lint | PASS: 25 warnings, no errors |

The first combined pass passed 490 tests; the second passed 52. They used one worker,
no file parallelism, the disposable PostgreSQL URL above and `nice -n 10`.
The temporary tracing and extra HTTP case were absent from both passes. Reports are
`/tmp/ci-flakes-11/tests-{1,2}.{log,json}`. Static results are
`/tmp/ci-flakes-11/static-results.jsonl` and the full lint log is
`/tmp/ci-flakes-11/lint-fixed.log`.

The first completed lint failed on an unbound clock-restore callback. A named cleanup
function fixed the binding. The full actor file then passed 36/36 twice, in 36.94 and
31.02 seconds. Reports are `/tmp/ci-flakes-11/actor-final-{1,2}.{log,json}`.
Full lint then passed in 907.34 seconds. The models workspace typecheck also passed
after the cleanup change; its log is `/tmp/ci-flakes-11/models-typecheck-final.log`.
The failed earlier lint is retained as `/tmp/ci-flakes-11/lint-final.log`.

Removed `pgtest-ci-flakes-11` with its volume after the tests. The owner stack was
untouched. No diagnostic source or configuration remains in the branch.

The interrupted earlier lint is not counted as a pass. The 30-run investigation
remains FAIL regardless of these later checks. Overall load qualification is PARTIAL.
The full root suite and fresh-install journeys are NOT RUN. CI will not be awaited.
