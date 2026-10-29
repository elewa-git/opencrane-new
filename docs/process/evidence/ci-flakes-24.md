# Decision dependency failures

Part of #576. Own checks on 29 October 2026.

## CI failure follow-up

Fetched `origin` and rebased onto `f973912f887319e62f3bb723fceddb40cd529a1f`.
The rebase finished with a clean worktree, and that main commit is an ancestor.
CI run `40832728271` used the earlier head `dd15d5f0f`.

The focused baseline reproduced all six reported failures. The ordinary tool call
and revocation read within the deadline passed. The decisions for each failure are:

| Case | Decision and fix |
| --- | --- |
| Tool history: 1,900 ms history plus 200 ms access | Timeout before access can be confirmed. Require exactly 503. Keep history order, saved refusal, no remote connection, no send and no reservation. |
| Tool history: 2,100 ms history plus no access delay | The shared request deadline has expired. Require exactly 503 and keep the same other assertions. |
| IAM outage at admission and final send | Admission cannot establish permission or refusal while IAM is paused. Require 503 there. The later dispatch check still requires its existing 403 and exact saved no-send evidence. |
| Memory delivery with permission lag | A missing receipt proves no loss of permission. Keep the exact `unavailable` result, no new memory record and no Stop. Fix the helper that mistook `AuthorityRefused('IAM projection behind')` for confirmed loss. |
| Gateway history timeout without revocation | No refusal is established. Require 503, retaining one earlier send and one earlier reservation. |
| Gateway revocation after the delayed history read | The grant read pauses for 2,200 ms. Its request deadline expires before it returns any new grant facts, so the decision has not observed the revocation. Require 503 and retain the exact send and reservation counts. The 20 ms revocation case still requires 403. |

`readStreamSummary` bounds the waiting caller with `readBeforeDeadline`, while its
history catch-up can continue separately. A saved event that this caller has not yet
read is not an established refusal. No deadline, access check or watched stream changed.

Test-only commit `c177cc86c` added the memory regression before fix `b1dbd00bb`.
It reproduced an invalidation with every grant still present and only receipts delayed.
The fix keeps this uncertainty separate from actual permission denial. Existing saved
member removal, assistant deactivation and grant-loss tests retain their assertions.
The focused follow-up passed all 12 selected cases. Both authority files are unchanged.

The complete gateway file found three further old status expectations. A separate
focused run reproduced each one at its fault-injection assertion:

- `settles streamed gateway usage exactly...`: paused IAM returns 503. The later
  applied member removal still requires 403, and provider calls stay at one.
- `does not duplicate exhaustion after its append succeeds but the acknowledgement
  is lost`: the uncertain budget save returns 503. Recovery still requires 402,
  one saved exhaustion, the same full budget history and no second provider call.
- `enforces reviewed tool modes...`: paused IAM returns 503. Grant revocations,
  inactive assistants and blocked tools still require 403. Saved decision records,
  privacy checks and send counts are unchanged.

These are status-only test corrections. The complete gateway file is repeated
after them, so every changed test runs twice with its final assertions.

The complete selected group has 12 files: server integration access and memory delivery;
models gateway, decision activity, grants, cost, refusal, precedence and fence;
MCP dispatch; and both authority files. There is no `decision.test.ts`.
All tests use the supplied PostgreSQL test URL on port 55432 and normal disposable
fixtures. Commands run under `nice -n 10`; complete passes use two workers.
Full root tests and fresh-install qualification are NOT RUN.

| Own check | Result |
| --- | --- |
| Initial complete pass | FAIL: 495 passed, three old gateway status expectations failed, one opt-in real-API test skipped |
| Corrected complete gateway file | PASS: 82 passed, the same real-API test skipped |
| Second complete pass | FAIL: 496 passed, two unchanged success cases failed, one opt-in real-API test skipped |
| Full lint | PASS: 33 warnings, no errors |
| Changed source and test lint after the status corrections | PASS |
| Full typecheck and final models typecheck | PASS |
| `check:events` | PASS: 157 event types agree |
| Separate Knip and `lint:changelog` | PASS |

The initial complete pass took 1,125.32 seconds. The corrected gateway repeat took
406.08 seconds. The second complete pass took 1,343.67 seconds.
`MODELS_REAL_CALL` was not enabled; that opt-in test is NOT RUN.
The first run loaded the earlier gateway assertions. Its final failure excerpts
show the subsequently edited source lines; the separate focused failure log preserves
the original 403 assertions. No production code changed during these runs.

All reported CI cases and the three additional gateway status corrections passed
with their final assertions twice. Both unchanged authority files passed twice.
The second complete pass still failed these unchanged success cases:

- `decision-cost.test.ts:708`, `keeps 10,000 members on one model and eight models
  with 1,000 members cached in one process`: HTTP 503 with `Decision service unavailable`
  instead of 200. Its two-second, read-volume and reservation assertions are unchanged.
- `mcp-dispatch.test.ts:2848`, `saves a checked remote response against its consumed
  permit once: result`: HTTP 403 instead of 200. Its exact response, saved evidence,
  consumed-permit and single-send assertions are unchanged.

Both cases passed in the first complete pass. These results do not establish their
underlying causes, and no retry erases the failures. Overall test qualification remains
FAIL; this follow-up does not claim to fix the earlier load failures or every intermittent
dependency failure. Full root tests, real-API calls and fresh-install qualification are NOT RUN.

Logs use the `/tmp/ci-flakes-24-` prefix: `followup-red.log`, `memory-red.log`,
`followup-green.log`, `extra-status-red.log`, `followup-run1.log`,
`gateway-final-run1.log`, `followup-run2.log`, `followup-lint.log`,
`followup-changed-lint.log`, `followup-typecheck.log` and `final-models-typecheck.log`.

## Refusals during dependency failures

Rebased onto `68428e46e133df2c10c88c28b9356ff80681f85f` after fetching `origin`.
The rebase finished, and that main commit is an ancestor of this branch.
The documentation conflict kept both the OAuth test notes and decision failure notes.

Test-only commit `931a920b2` came before implementation commit `9bb134403`.
Before the fix, both missing-receipt response orders, an inactive assistant and a
removed member followed by an audit failure returned 503 instead of 403.
The silo mismatch and mixed permission denial/outage tests already passed.
The two existing history/access timeout assertions also reproduced their 503/403 mismatch.
After the fix, all eight selected checks passed. Further focused coverage passed
for a missing receipt in a later batch, an unresolved budget write and an MCP outage.
Commit `3a6b52368` fixed test lint errors without changing the assertions.

Receipt checks now finish before their results are classified. A confirmed missing
receipt takes priority over an unavailable check, including across batches.
A saved inactive assistant is refused before receipt checks. Membership and authority
refusals retain 403 if saving the deny audit fails. The removal tests keep the outage
active and leave the old team membership in IAM.

The shared history/access timeout requires exactly 503. `plan.md` requires the call
to stop when context cannot be read; it does not require 403. The engineering standard
separates unavailable dependencies from refused input. A timeout confirms no access
denial, and neither deadline changes. Both timeout tests still require no reservation
and no send; they also check the unavailable response body and absent reservation header.
`authority.test.ts` and `authority-volume.test.ts` remain unchanged from main.

### Follow-up checks

All commands used `nice -n 10`. Tests used one worker and the supplied test PostgreSQL
service on port 55432. Their normal disposable NATS, OpenFGA and gateway fixtures ran.
No root suite, secondary development stack or fresh-install journey was started.

The nine-file comparison group contains: `decision-activity`, `decision-grants`,
`decision-fence`, `decision-cost`, `decision-refusal`, `decision-precedence`,
`mcp-dispatch`, `authority` and `authority-volume`, all under `libs/models/test/`.
There is no `decision.test.ts`; the first pass added activity and grants in a second
command. The repeat selects the whole group together and also includes the three
`authority-standalone` cases. A separate command repeated those three cases successfully in 20.98 seconds.
Every selected case therefore ran twice.

| Check | Result |
| --- | --- |
| First complete test pass | FAIL: 319 passed, 1 failed, none skipped |
| Second complete test pass | PASS: 323 passed across 10 files, none skipped |
| Additional standalone-authority repeat | PASS: 3 cases; these also passed in the second complete command |
| Full lint | PASS: 33 warnings, no errors |
| Full typecheck and models typecheck after test lint fixes | PASS |
| `check:events` | PASS: 157 event types agree |
| Separate Knip and `lint:changelog` | PASS |

The first test failure was the large-cache case at `decision-cost.test.ts:708`:
`Decision service unavailable` (503) instead of the required 200. Its success and
sub-two-second assertions are unchanged. The seven-file command took 1,864.26 seconds;
the additional two files passed 15 cases in 49.35 seconds. The same named case appears
in the earlier load failures below. These checks do not establish its underlying cause.

The second complete command passed all 323 cases in 1,702.65 seconds, including
the large-cache case. Its slowest measured call was 1,898 ms. This later pass does
not erase the earlier failure or establish that the intermittent failure is fixed.

Local logs are `/tmp/ci-flakes-24-run1.log`, `/tmp/ci-flakes-24-run1-extra.log`,
`/tmp/ci-flakes-24-run2.log`, `/tmp/ci-flakes-24-authority-standalone-repeat.log`,
`/tmp/ci-flakes-24-red.log`,
`/tmp/ci-flakes-24-green.log` and `/tmp/ci-flakes-24-added.log`.
The final lint log is `/tmp/ci-flakes-24-lint-final.log`.
The initial lint run found three test errors; the changed files and full lint passed
after fixing them. No assertion was relaxed. Final documentation checks also passed.

The earlier load qualification remains FAIL. Full root tests and fresh-install live
qualification are NOT RUN. CI will not be awaited after pushing.

## Earlier investigation

The following sections preserve the earlier measurements and their limits.

## Change and environment

Base: `8b93ce3c155382bc681622e8e62a948216400f16`, fetched from `origin/main`.
The clean worktree ran `npm ci` and reused the installed NATS, Lychee and gateway
binaries through local symlinks. Tests used disposable NATS and OpenFGA services.
Load runs used a throwaway PostgreSQL 17.6 container. Required focused checks used
the supplied PostgreSQL test service. Every test, lint and typecheck command ran
under `nice -n 10`. Node was 22.23.3. This was a development checkout, not a fresh installation.

## Reproduction and failing tests

Temporary local logging recorded the decision stage, reason and exception.
It was removed before the fix was committed.

The main load run reproduced the original failure at `decision-cost.test.ts:708`:
`access_and_budget`, `event_store_unavailable`, a NATS `TimeoutError`, and HTTP 403
with `Request refused or decision service unavailable`. It took 3,346 ms.
Another test process was running the two complete decision files alongside it.
Both Vitest workers loaded the original decision code before the fix was edited.
Editing began before the long MCP baseline command finished. Its later replay
subprocesses may therefore have read edited files; their unrelated failures are
observations, not a separate clean-main comparison. The original loaded decision
code produced the traced 403 above. All 20 final repetitions use the settled fix.
The previous [main comparison](https://github.com/elewa-git/opencrane-new/pull/800#issuecomment-6485629347)
also identified an unavailable IAM receipt check reported as a missing receipt.

Four later probes used a separate checkout of the same main commit with its own
`npm ci`. Only temporary logging changed there. Two selected the large-cache case
and passed (one case each, 27 skipped). Two ran the whole decision-cost file and
passed all 28 cases each. They overlapped the final load pair, keeping the total
at four workers. These probes did not reproduce the intermittent timeout again.
Their extra logging therefore cannot identify which individual NATS operation
failed in the earlier `access_and_budget` stage. The original timeout is confirmed;
its exact stream or budget operation remains unresolved. The separate checkout
and all its temporary logging were removed.

Test-only commit `d33eab665` preceded the production fix. Eight new HTTP cases
failed with 403 where 503 was required: history, access and grant reads, a budget
write, and failed membership, receipt and resource checks plus a slow membership
check. The existing diagnostic case passed. The first draft of these tests omitted
`stream: true`; that invalid request was corrected before this test-only commit.
The budget fixture was later corrected to prove its failed write was not sent
before requiring a successful retry. Unknown writes still block recovery.

An initial baseline launch lacked the gateway binary. It was stopped and the
binary was linked before restarting. That launch is a setup failure, not test evidence.

## Own checks

Production source: `4241f4acaeb21d0003589e7bd77294722d3e2c7b`.
The final receipt-only commit does not change that tested code.

| Check | Result | Detail |
| --- | --- | --- |
| Full typecheck | PASS | All workspaces, package and dev-stack checks |
| Event catalogue | PASS | 157 event types agree |
| Separate Knip | PASS | No unused or unlisted dependency remains |
| Changelog | PASS | Branch fragment accepted |
| Final changed-file lint | PASS | Two existing function-length warnings; no errors |
| Final regression file, run 1 | PASS | All 9 cases |
| Final regression file, run 2 | PASS | All 9 cases |
| First broader focused run | FAIL | 499 passed, 2 failed: cold-history timeout and cache-volume 503 |
| Second changed-suite run | FAIL | 36 passed, 1 failed: cache-volume 503 |
| Unchanged authority suites | PASS | Both files passed in the first broader run |
| Security rules | PASS | All 460 cases, once in the first broader run |
| Full lint | PASS | Code, dependencies, Knip, docs, links, licences and changelog |

The first full lint attempt stopped with an ESLint internal exception after files
changed while it ran. Focused lint then found a file-length limit and an unsafe test
matcher. The response helper was extracted and the matcher replaced with a strict
schema. Full lint then passed against the settled code.
The first separate Knip attempt found a test import from an unlisted dependency.
The test now obtains a real timeout through the installed event-store interface;
no dependency was added.

The two changed-suite commands used the supplied PostgreSQL test URL. The first
also included both unchanged authority files and the security rules. Both ran under
`nice -n 10`. After the response helper was extracted, the final regression file
passed twice more. Cold-history tests now require exactly 503; the allowed-call
assertions still require exactly 200 and keep the two-second limit.

The baseline pair was FAIL: the complete two-file run had 204 passing and 4 failing
cases. These were cold-history timeout, cache-volume 403, expired-approval replay,
and the saved-start ordering check. The parallel decision-cost-only run had 27
passing cases and the cache-volume 403. The specific `gateway_502` case passed in
the complete baseline run; the earlier main evidence and the new HTTP proxy tests
cover the IAM receipt failure separately.

## Full-file load runs

Each run includes every case in `mcp-dispatch.test.ts` and `decision-cost.test.ts`,
with a total limit of four Vitest workers. Runs 1–2 use two workers per command;
runs 3–20 use four parallel commands with one worker each. The last two commands
also run alongside each other. Every command uses `nice -n 10` and the throwaway
PostgreSQL service. No case is selected out and no assertion is relaxed.
Safe local logs and JSON reports are in `/tmp/ci-flakes-24/` as `load-NN.log` and
`load-NN.json`; `load-results.json` retains command exits and durations.

Completed: **20/20**. Passing runs: **2/20**. Tests: **4107 passed, 53 failed, 0 skipped**.
A later pass does not erase an earlier failure. The overall load qualification remains **FAIL**.

| Run | Result | Passed | Failed | Skipped | Large-cache case | `gateway_502` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | FAIL | 206 | 2 | 0 | FAIL (503) | PASS |
| 2 | FAIL | 206 | 2 | 0 | PASS | PASS |
| 3 | FAIL | 201 | 7 | 0 | FAIL (503) | PASS |
| 4 | FAIL | 204 | 4 | 0 | PASS | PASS |
| 5 | FAIL | 201 | 7 | 0 | FAIL (503) | PASS |
| 6 | FAIL | 201 | 7 | 0 | FAIL (503) | PASS |
| 7 | FAIL | 205 | 3 | 0 | FAIL (503) | PASS |
| 8 | FAIL | 207 | 1 | 0 | FAIL (503) | PASS |
| 9 | FAIL | 207 | 1 | 0 | FAIL (503) | PASS |
| 10 | FAIL | 207 | 1 | 0 | FAIL (503) | PASS |
| 11 | FAIL | 204 | 4 | 0 | PASS | PASS |
| 12 | FAIL | 205 | 3 | 0 | PASS | PASS |
| 13 | FAIL | 206 | 2 | 0 | PASS | PASS |
| 14 | PASS | 208 | 0 | 0 | PASS | PASS |
| 15 | PASS | 208 | 0 | 0 | PASS | PASS |
| 16 | FAIL | 206 | 2 | 0 | FAIL (503) | PASS |
| 17 | FAIL | 205 | 3 | 0 | FAIL (503) | PASS |
| 18 | FAIL | 206 | 2 | 0 | FAIL (503) | PASS |
| 19 | FAIL | 207 | 1 | 0 | PASS | PASS |
| 20 | FAIL | 207 | 1 | 0 | PASS | PASS |

### Every failed case

Repeated failures are grouped by the test name and observed error. Run numbers
identify every occurrence. These results remain failures.

| Test | Observed error | Runs |
| --- | --- | --- |
| lets a cold models process catch up and then admits using only the chat tail | TimeoutError: timeout | 1, 2, 6 |
| keeps 10,000 members on one model and eight models with 1,000 members cached in one process | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 1, 3, 5, 6, 7, 8, 10, 16, 17, 18 |
| allows two concurrent calls on the same tool | AssertionError: {}: expected 403 to be 200 // Object.is equality | 2 |
| admits model and ordinary MCP calls from the same decision process | AssertionError: authentication failure: the token is invalid or malformed: Error(InvalidSignature): expected 401 to be 200 // Object.is equality | 3, 4 |
| refuses old approval after watch recovery: failed, retry false | TimeoutError: timeout | 3, 5, 6 |
| restores drift only through exact live publication: exact | Error: Command failed: npm run replay -- audit --verify | 3 |
| restores drift only through exact live publication: intent only | Error: fetch failed | 3 |
| restores drift only through exact live publication: unpublish | Error: fetch failed | 3 |
| restores drift only through exact live publication: restart before | Error: fetch failed | 3, 5, 12 |
| denies mutable servers without an operator-reviewed atomic revision contract | AssertionError: authentication failure: the token is invalid or malformed: Error(InvalidSignature): expected 401 to be 403 // Object.is equality | 4 |
| refuses a hosted image without recorded image admission | TypeError: fetch failed | 4, 5 |
| restores drift only through exact live publication: exact | Error: Command failed: npm run replay -- conversations --confirm-conversations-stopped | 4 |
| refuses old approval after watch recovery: failed, retry true | TimeoutError: timeout | 5 |
| restores drift only through exact live publication: duplicate after drift | Error: fetch failed | 5 |
| restores drift only through exact live publication: drift during final read | Error: Gateway delivery unavailable | 5 |
| checks zero-cost MCP spending stops for renewed token | TypeError: fetch failed | 6 |
| refuses old approval after watch recovery: stalled, retry true | Error: Catalogue watch stopped or timed out | 6 |
| restores drift only through exact live publication: exact | Error: expected 404 to be 200 // Object.is equality | 6 |
| refuses spoofed unacknowledged constants with 1 copies | Error: fetch failed | 6 |
| restores drift only through exact live publication: intent only | Error: expected 404 to be 200 // Object.is equality | 7 |
| guards published HTTPS tool calls: deadline | Error: expected +0 to be 1 // Object.is equality | 7 |
| keeps 10,000 members on one model and eight models with 1,000 members cached in one process | AssertionError: {"error":"Decision audit unavailable"}: expected 503 to be 200 // Object.is equality | 9 |
| keeps decision reads flat at 10, 100 and 500 turns and at 10 and 3,000 chat events | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 11 |
| keeps a stopped free turn from model sends after recovery: refused MCP pass | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 11 |
| restores drift only through exact live publication: restart after | Error: fetch failed | 11 |
| restores drift only through exact live publication: drift during final read | Error: fetch failed | 11 |
| refuses old approval after watch recovery: stalled, retry true | AssertionError: expected 401 to be 503 // Object.is equality | 12 |
| restores drift only through exact live publication: older generation | Error: Gateway delivery unavailable | 12 |
| restores drift only through exact live publication: expired | Error: Gateway delivery unavailable | 13 |
| keeps another server approval through memory reload | Error: fetch failed | 13 |
| holds recording upstream through failed and recaptures on worker replacement | Error: Catalogue watch stopped or timed out | 16, 17 |
| requires the latest team team revocation receipt while IAM still allows | AxiosError: timeout of 1000ms exceeded | 17 |
| refuses computer-assistant history restored below its summary without reserving more money | Error: Test timed out in 40000ms. | 18 |
| checks remote adapter evidence without resending: outage | Error: fetch failed | 19 |
| guards published HTTPS tool calls: wrong_name | AssertionError: {"error":"Decision service unavailable"}: expected 503 to be 200 // Object.is equality | 20 |

## Not run

The full root suite and fresh-install live qualification were NOT RUN.
CI is not awaited after opening the draft pull request.
