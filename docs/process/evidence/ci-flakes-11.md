# Budget writer recovery and approval retries

## Typed append outcomes and unknown-state recovery, 25 October 2026

A definite conditional rejection followed by a recovery-read timeout used to stop an unchanged
budget writer. `EventStore.appendOutcome` now reports distinct typed outcomes. A failed recovery
read returns `conditional_rejection_unknown` immediately. The actor refuses that request and
reads the budget before the next queued command. Only a confirmed budget change or lost
ownership stops it. The read must succeed before another money decision; repeated read failures
keep recovery pending.

The store distinguishes a new append, a duplicate already saved, a rejection with changed state,
a rejection with unchanged state, a rejection with unknown state, a transport failure and
invalid input or a colliding id. A definite rejection cannot erase uncertainty from an earlier
lost reply. The original `append` method maps these results to the existing command API, keeping
other callers unchanged. Budget duplicate recovery reads the exact saved event and applies its
stored payload.

### Failing-first evidence and retained checks

Tests were committed first in `1d27ce585`, followed by the guard coverage and test adapter
changes in `7c649e7d3`, before the implementation in `de1ce58f4`. The first reproduction failed
with `Budget writer lost its fence` instead of the request-only refusal. The new store-result
tests failed because the typed API did not exist yet. Actor tests for unknown transport results
and lost replies also failed before the actor changed. Logs are `reproduction-red.log`,
`outcomes-red.log` and `actor-outcomes-red.log` in the directory below.

The retained reproduction uses a real NATS conditional rejection (10071 or 10164), then forces
its recovery read to throw `TimeoutError`. It checks one rejection, one failed read, an
unchanged budget, no saved admission and a successful later reservation. The store now ends
after callback two, before the old third callback could refuse access. The next request must
read the budget again.

The focused event-store and actor run passed 65/65. The refreshed core suite passed 92/92 twice.
After the final queue callback and command-construction cleanup, the actor passed 59/59 twice;
scoped lint and typecheck passed too. Five additional guard cases passed: the fallback two-second limit and the actor's check after a callback, foreign-silo and foreign-subject switch-on
rows, and exact deadline transfer from MCP dispatch. Seven temporary loader mutations caused
eight targeted tests to fail as expected. These removed or changed those guards, erased earlier
lost-reply uncertainty, or confused recovery-read failure with transport failure. No mutation
changed repository files. Logs are `second-green.log`, `guards-green.log` and `mutation-*.log`.

The first implementation check exposed a test spy calling itself after the API change and a
timeout assertion using the wrong case. Both were corrected; the second run passed. Scoped lint
caught file-size and complexity limits. The unchanged stream configuration checks moved to
`stream-config.ts`; budget result and history checks moved to `budget-append.ts`. The dependency
check then required the new configuration file in the explicit NATS adapter list. Full lint then
caught a generic method binding, a file one line over its limit and an async test iterator
without an await. A named queue callback and the existing budget append helper now hold these
steps clearly. A strict optional-property test fixture was corrected by omitting the flag. Knip
caught a test-only NATS import that was not a declared models dependency. The test now gets the
same error class from the existing event-store test helper; no dependency was added. The import
check, four targeted regressions and both affected package typechecks passed. No application
permission, money, memory, conditional-write or two-second deadline check was removed or
weakened.

### Base and setup

The initial rebase onto `d674ca2e5` finished after merging both README descriptions. Main then
added an unrelated worker fixture test. The second fetch and rebase onto
`786e21a19b4ab0da29140f7922222e9504ff598b` finished, with no rebase state left. Its changes did
not alter any event-store, models or server file. That base was an ancestor of the branch.
Selected tests had already started on identical source.

After both complete runs finished, the final fetch and rebase onto
`6ddd5bef191ee0490b0e315085575cdf955d3312` completed. The two README diagram conflicts retain
both publication receipts and write-outcome checks. No rebase state remains, the final base is
an ancestor, and all 17 TypeScript files changed by this PR are byte-for-byte unchanged. Main
added publication-receipt recovery and routine-list changes. Final-base tests include their
integration files, plus the budget writer, append outcomes and access gateway.

Focused checks used the supplied PostgreSQL URL on port 55432. The complete selected suites and
load batch use the throwaway PostgreSQL 17.6 container `pgtest-ci-flakes-11-fix3`, port 36058,
after `pg_isready` passed. Tests start their normal isolated NATS, OpenFGA and gateway fixtures.
All lint, typecheck and test commands use `nice -n 10`, with one worker per Vitest process. The
first complete selected pass overlaps the 30 approval-retry repetitions. No full root suite or
fresh-install journey was run. The owner stack and Docker daemon settings are unchanged.

Own logs and JSON reports are in `/tmp/ci-flakes-11-fix3/`.

### Own final results

Own checks, all run under `nice -n 10`:

- **PASS:** final-base full lint, typecheck, event catalogue, Knip and changelog checks. ESLint reports 25 warnings and no errors; Knip reports two configuration hints and no failures.
- **PASS:** final-base append, typed outcomes, actor, gateway integration, publication-receipt integration and routine-list tests: 172/172 twice, using the supplied PostgreSQL URL.
- **FAIL:** first complete 24-file run: 609 passed, seven failed, one optional browser case NOT RUN. Second complete run: 607 passed, nine failed, one optional browser case NOT RUN. All 117 event-store cases passed in both. The second run passed all 59 actor cases, including the retained rejection/read-timeout reproduction, and all 183 MCP dispatch cases.
- **FAIL:** all 30 approval-retry repetitions ran under load; 24/30 repetitions passed both cases, and 53/60 cases passed. The seven failures remain unexplained beyond the recorded diagnostic details.
- **PARTIAL:** overall qualification. Later passing runs do not establish the causes of earlier failures. Full root tests, fresh-install journeys and the optional browser case are NOT RUN.

### First complete-pass failures

The first complete pass had 609 passes, seven failures and one optional browser case NOT RUN.
Six failures were in `mcp-dispatch.test.ts`:

| Case | Recorded failure |
| --- | --- |
| Recording upstream during failed capture and worker replacement | A tool-policy history read reached its deadline. |
| Exact drift restoration with an expired approval | The `mcp-catalogue --verify` replay command failed. |
| Saved gateway generation after the last read | OpenFGA store creation timed out after one second during fixture setup. |
| Saved reload with an approved, non-pending approval | The `conversations --confirm-conversations-stopped` replay command failed. |
| Another server's approval through Odoo reload | HTTP 403 instead of 200. |
| Remote adapter redirect failure | Gateway witness polling returned 404 instead of 200. |

The actor's unknown-transport test failed before its assertions because the loaded test-helper
module did not yet export `TimeoutError`. This long-running process started before the test-helper export changed. The mixed source snapshot is an own validation setup error; the first run
remains FAIL. A fresh actor process passed 59/59, and the second complete pass uses stable
source. The real-NATS conditional-rejection/read-timeout reproduction passed in the first
complete run.

### Second complete-pass failures

The second complete pass had 607 passes, nine failures and one optional browser case NOT RUN.
All 117 event-store cases, 59 actor cases, 183 MCP dispatch cases, 75 decision-fence cases and
74 executed server approval cases passed. Both gateway approval-recovery cases passed. The nine
failures were:

| File and case | Recorded failure |
| --- | --- |
| Gateway integration: both grant sides, starting with member | HTTP 403 instead of 200; the saved dispatch result says `not_dispatched` with `adapter_dispatch_refused`. |
| Decision activity: warmed 5,000-event provider history | The test reached its 30-second limit. |
| Decision cost: flat reads across chat and turn history | HTTP 403 instead of 200 during the long-chat measurement. |
| Decision cost: cold process catches up before reading the chat tail | The event-store read reached its deadline. |
| Decision cost: 3,000 model grants | HTTP 403 instead of 200. |
| Decision cost: 15,000 edits to one grantee | NATS timed out while seeding the fixture. |
| Decision cost: 10,000 members and eight models | NATS timed out while seeding the fixture. |
| Managed decision: bound call settles once | HTTP 503 instead of 200. |
| Managed decision: cold 5,000-event provider history | HTTP 403 instead of 200; recorded history duration was 11,412 ms. |

These cases passed in the first run. That does not establish why they failed in the second run,
and they remain FAIL. No deadline, assertion or access check was changed to obtain a pass. Full
details are in `selected-2.log` and `selected-2.json`.

### Load diagnosis

All 30 repetitions ran alongside the selected suites, with static checks also running for part
of the batch. There were 24 completely passing repetitions and 53/60 passing cases. Repetitions
3, 4, 5, 6, 8 and 15 failed: 5 failed both cases; 3 and 15 failed budget-admission recovery; 4,
6 and 8 failed saved-start recovery. Every failed case returned `[403, 403]` instead of `[200,
403]`. No failed run was replaced by a passing rerun.

The first extra diagnostic passed both retry cases. The second reproduced both unexpected `[403,
403]` results. Its saved-start retry failed at `final_access`, with `event_store_unavailable`,
1,176 ms into dispatch and 185 ms after the original access deadline. The budget-admission retry
failed at `budget_admission`, with `event_store_unavailable`, 683 ms into dispatch and 257 ms
after that deadline. Their permit expiry times still had 818 ms and 1,302 ms left. The original
access deadline correctly remained stricter than the later permit expiry.

These measurements locate two failed retries after the access deadline. They do not explain all
failed repetitions or establish why the request exhausted its budget. They do not prove host
contention, nor do they prove an application performance defect absent. The load failures remain
FAIL. The temporary loader logged only fixed reason labels, result types and time measurements,
and did not change any check or test assertion. Logs are `diagnostic-1.log` and
`diagnostic-2.log`.

The throwaway PostgreSQL container and its volume were removed with `docker rm -f -v pgtest-ci-flakes-11-fix3` after the complete runs. Final-base focused checks use the supplied PostgreSQL
URL on port 55432. No owner container was removed.

The remaining sections record earlier commits and checks. Their descriptions of
when the writer stops are historical; the typed outcomes above describe the current code.

## Definite append rejection correction, 24–25 October 2026

An id used by an unrelated member event could refuse a budget command and stop
its unchanged writer permanently. Invalid-event rejection by the store had the
same problem. Both now refuse only that command. Exact duplicates keep their
earlier result. An uncertain publish still stops the writer because its saved
budget position may have changed. No access, money, memory or deadline check,
or test assertion, was removed or relaxed.

The test-first sequence is retained in `691fc8cb9` (tests) and `df52bb10d` (fix).
The original commits were `a7015110d` and `968607b29` before the final rebase.
Three regressions failed before the fix: duplicate-id collision on the first
append, collision after a conflict, and invalid-event rejection by the store.
All three passed after the fix. The focused audit passed 8/8, including exact
retries, thrown append errors, conflict-read errors and unchecked contention.
Logs are `rejected-red.log`, `rejected-green.log` and `audit-green.log` below.

### Bases and test setup

The initial fetched base was `f4f4fecb13df380882293bd37745b1d388412b52`.
The complete 16-file passes and load batch used source `968607b29` on that base.
Main then added indexed finance reads. The final fetched base is
`3b623f52a841601a62c99629790cf4f2d08e0839`; the final source fix is `df52bb10d`.
Both rebases finished, the final base is an ancestor, and no rebase state remains.
README conflicts preserved main's finance description and the budget-write notes.
All 11 TypeScript files changed by this PR remained byte-for-byte unchanged.

Node was v22.23.3. The failing-first run used the supplied PostgreSQL URL on port
55432. Complete suites and final-base checks used the throwaway PostgreSQL 17.6
container `pgtest-ci-flakes-11-fix2` on port 35523 after `pg_isready` passed.
Tests started their normal isolated NATS, OpenFGA and gateway fixtures.
Every test, lint and typecheck command used `nice -n 10`. Each Vitest process had
one worker. The first complete pass overlapped all 30 approval-retry invocations.
Own logs and JSON reports are in `/tmp/ci-flakes-11-fix2/`.

### Own results for this correction

| Check | Result |
| --- | --- |
| First complete 16-file pass | FAIL: 540 passed, 6 failed, 1 optional browser case NOT RUN |
| Second complete 16-file pass | PASS: 546 passed, 1 optional browser case NOT RUN |
| Actor and gateway integration within those passes | PASS twice: 54 actor and 17 integration cases each |
| Final-base accounting, actor, append and gateway integration | PASS: 116/116 twice |
| Final-base lint, typecheck, event catalogue, Knip and changelog | PASS; ESLint has 25 warnings and no errors |
| Approval retry under load | FAIL: 22/30 invocations; 50/60 cases passed |

The complete passes include actor, all decision files, MCP dispatch, server
approvals, approval cancellation/record, root append retry, gateway integration,
and event-store append/history-checked/read-retry tests. Their reports are
`selected-{1,2}.json`. Final-base reports are `final-tests-{1,2}.json`.
The initial scoped lint caught complexity 16 in append; grouping the unavailable
result checks reduced it to 15 without removing a check. Full lint then passed
on both bases. Final static logs start with `final-`.

### Retained failures and diagnostics

The first complete pass had three MCP approval-reload failures in replay CLI
commands: one conversation replay and two catalogue verification commands.
Their helpers retain the existing ten-second subprocess limits. The approval
UTC-date case failed during OpenFGA fixture setup with a one-second Axios timeout.
The owning-team grant revocation case reached its 40-second test limit.
The 10,000-member cache case returned HTTP 403 where HTTP 200 was required.
All six passed in the second complete run; this does not establish their causes.

Load invocations 10, 15, 16, 17, 18, 19, 21 and 23 returned `[403, 403]` instead of
`[200, 403]` for competing retries. Both cases failed in 15 and 21; the other six
had one failure each. No failed invocation was replaced by a passing rerun.
An extra diagnostic reproduced the saved-start failure at `budget_admission`,
with the fixed reason `decision_unavailable`, after 521 ms in the dispatcher.
That label does not establish its cause. A temporary loader added fixed labels
for the nested cause of `Budget append unavailable`, without raw exceptions or
behaviour changes. Four diagnostic invocations then passed both cases (8/8),
so the earlier failure remains unexplained. No diagnostic source was committed.

Removed the throwaway database and its volume with `docker rm -f -v` after testing.
The owner stack and Docker daemon settings were untouched. Overall qualification
is PARTIAL. Full root tests, fresh-install journeys and the optional approval
browser case are NOT RUN. Earlier results below remain recorded.

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
