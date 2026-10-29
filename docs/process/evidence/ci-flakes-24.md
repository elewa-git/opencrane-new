# Decision dependency failures

Part of #576. Own checks on 29 October 2026.

## Fourth failure follow-up

Fetched origin and completed the rebase onto
`b7db73b36a769bee3422da01e36ffcf26b6023b6`. Verified that commit is an ancestor
and that neither rebase state directory remains.

The owner supplied the missing decision: require the existing fixed outage text
when the provider-history timeout returns 503. The shared dependency-outage handler
returns exactly `Decision service unavailable`, without the underlying cause.
The focused test first reproduced the old exact-message failure. Test-only commit
`a2999e592` replaces that expected text with the shared outage message. It retains
the exact string comparison, 503 status, ten-second lower and twelve-second upper
limits, zero reservations, zero reserved and spent cents, and no provider call.
No product behaviour changes in this follow-up.

All commands used `nice -n 10`. Tests used
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and normal disposable
service fixtures. No full root suite or fresh-install journey was run.

| Check | Result |
| --- | --- |
| Focused provider test before the correction | FAIL as expected: old refusal text differs from the fixed outage text |
| Full lint | PASS: 34 warnings, no errors |
| Full typecheck | PASS |
| Event catalogue | PASS: 157 event types agree |
| Separate Knip and changelog lint | PASS |
| First eight-file test run | FAIL: 338 passed, one concurrent-credential case failed |
| Second eight-file test run | FAIL: 338 passed, one large-cache case failed |
| Routine timeout cases, first and second runs | PASS: all three cases in each run |
| Full root suite, fresh-install qualification and post-push CI | NOT RUN |

The eight complete files cover decision cost, grants, refusal, precedence, activity,
fence, managed decisions and MCP dispatch. The routine selection covers stalled
history and unavailable event-store reads during preparation and confirmation.

The first run's unchanged `keeps concurrent calls tied to their own connection
credential` case received 503 instead of 200 at `managed-decision.test.ts:163`.
Its exact success, separate credentials, reservation and send assertions remain
unchanged. The run does not establish the cause. The corrected provider timeout
passed, including its later timing, money and no-send checks.

The second run passed all managed-decision cases, including the corrected provider
timeout and the concurrent-credential case. It failed the unchanged large-cache
case at `decision-cost.test.ts:708`, which returned 503 with the fixed outage text
instead of the required 200. This case passed in the first run and also failed
during the previous follow-up. Its success, timing, access, read-volume and money
assertions remain unchanged. No cause is established by this run.

The corrected provider timeout, decision fence, refusal, precedence, activity,
grants and complete MCP dispatch file passed twice. Overall qualification remains
PARTIAL because the two broader runs failed. No retry erases either failure.

Local logs use `/tmp/ci-flakes-24-fix4-`: `before.log`, `tests-1.log`, `tests-2.log`,
`routine-1.log`, `routine-2.log`, `lint.log`, `typecheck.log`, `events.log`,
`knip.log`, `changelog.log` and `docs.log`.

## Third failure follow-up

Fetched origin and completed the rebase onto
`52cec3f67e396daf0597f614dbaba59238526cc8`. Verified that commit is an ancestor
and that neither rebase state directory remains. The rebased comparison head was
`bdbcce9c164ee684159123b91dac4da6cc5b98c4`.

The provider-history case from CI run `40843426477` reproduced 503 instead of 403.
Commit `231298d04` changes only that status, as requested. The status-only version
then failed twice on its existing exact message: it expects
`Request refused or decision service unavailable`, while the established 503 reply
is `Decision service unavailable`. The message assertion remains unchanged pending
the requested clarification. Its timing, no-money and no-send assertions are retained,
but those later assertions are not reached in these failing runs.

The repository search found an additional product error: routine preparation and
confirmation caught recognised dependency failures and changed them into
`RoutineDispatchRefused`. Test-only commit `1e0560450` reproduced three incorrect
403 replies: stalled history and event-store read timeouts during preparation and
confirmation. Commit `2cbc1bf28` preserves those failures through both catches.
The existing completion deadline still applies. A complete but expired read also
uses the existing deadline error. Missing or mismatched routine evidence, saved
Stop, Pause, Retire and access loss retain their refusals.
The focused follow-up passed all 21 cases, including the unchanged saved-refusal
and failed-audit checks. No source dependency or event type was added.

### Repository status audit

The repository search covered every `*.test.ts`, `*.spec.ts`, `*.test.mjs` and
`*.test.js`, including apps, libraries, infrastructure and spikes. It found 1,173
lines containing `403` or `forbidden`. I compared those with timeout, outage,
unavailable, deadline, stall, pause, delay, slow and expiry terms, then followed
shared assertion helpers and the decision endpoint callers.

| Case | Decision |
| --- | --- |
| Managed provider history exceeds ten seconds | No refusal was read. Require 503; retain every timing, money and no-send assertion. |
| Routine history stalls beyond ten seconds | No refusal was read. The helper wrongly converted its timer error to `RoutineDispatchRefused`. Preserve the unavailable error and require 503, no refusal marker and no reservation. |
| Routine event-store failure during preparation or confirmation | The same catch hid recognised event-store failures. Add both failing-first cases and preserve their errors. |
| Gateway delayed grant history; model/MCP shared request deadline; integration tool history; paused IAM; uncertain budget save | Already require 503 in this PR. Keep those corrections and their exact money/send checks. |
| Gateway grant revocation read within the deadline; saved member removal; inactive assistant; missing IAM receipt; routine Stop/Pause/Retire/access prohibition | Confirmed refusal. Keep 403, including when another dependency or the deny audit fails. |
| MCP catalogue check failure or stall, recovery after a failed check, and held changed tools | Saved failed catalogue evidence or a local catalogue hold prevents use. Keep 403; recovery still needs fresh reviewed publication. |
| Approval renewal after failure/drift and Codex approval timeout | The saved approval is cancelled or expired. Keep 403 and its saved-state assertions. |
| Encrypted approval review cannot be read | The approval is still requested, not approved. Keep the unsent call at 403 and the approval write at 503; no approval is granted. |
| MCP dispatch IAM outage, lost start, unavailable budget admission, DNS/permit timeout and catalogue hold | Final dispatch has its separate 403/no-send contract. Keep exact refusal and evidence assertions. Remote response timeouts remain 504; response failures remain 502. |
| MCP or egress retries after an uncertain send or closure | The permit was consumed or closed. Keep 403 and the one-send rule. |
| Gateway recovery with an old budget actor | The replacement writer has taken ownership. Keep the old writer's 403 and the held money. |
| Native delegation's unavailable or late agreement read | The public native route remains disabled and uses its existing agreement-refusal contract. Keep 403; this PR does not enable native calls. |
| Memory backend admission timeout, uncertain evidence, signing/verification configuration and expired memory | These assert the memory backend's separate refusal contract or missing required capability, not a recognised outage at model/MCP decision admission. Keep the exact assertions; no memory check changes. |
| Decision diagnostic test's generic `Private backend error` | This injects an untyped exception, not a recognised event-store outage/timeout. Keep its existing 403 and private-log assertions. The typed service-failure cases separately require 503. |

No authority test, access limit, money check or memory assertion changed.

### MCP dispatch comparison

Every batch repeated the original `savesRemoteResponse('result')` test twenty times
with fresh normal fixtures. Temporary test registration supplied repetition numbers;
its assertions were unchanged. Temporary logging recorded the refusing dispatch stage,
fixed reason, elapsed time, remaining time and source locations. The two checkouts
used their own workspace package links and the same installed dependency versions.
No product delay, clock mock, deadline extension or bypass was introduced.

| Load | Rebased head | Main |
| --- | --- | --- |
| Concurrent repeats under existing shared-box load | 20 passed | 18 passed; two failed while preparing gateway delivery/witness fixtures |
| Both test processes and their child fixtures confined to CPU 0 | 19 passed; one dispatch failure | 20 passed |
| Same CPU 0 with four competing low-priority CPU workers | 1 passed; 18 dispatch failures and one fixture failure | 19 dispatch failures and one fixture failure |

All three batches used `nice -n 10` and one Vitest worker per revision. The deliberate
CPU load was confined to one core and removed when the comparison ended.
The requested success case remains exactly HTTP 200; these load runs are FAIL.

The second head batch failed repetition 18 at `mcp_admission`, with
`event_store_unavailable`, after 1,915 ms of dispatch and 305 ms beyond its original
access deadline. The source was `EventStore.head` from the authority position check
inside `confirmDecisionAccess`, reached through `currentAuthority`.

The third batch reproduced the same stage and error on both revisions. For example,
head repetition 3 failed at `mcp_admission` after 1,103 ms, 217 ms beyond the access
deadline; main repetition 9 failed there after 1,261 ms, 283 ms beyond the deadline.
Both stacks identify the timeout in `libs/event-store/src/jetstream.ts:158`.
There were three `mcp_admission` event-store timeouts on each revision in that batch.
Both also failed at access confirmation during budget admission, at the same
`withinBudgetDeadline` timer. Main's older diagnostic map uses a generic label for
that budget error; the source location agrees.

This proves that a permitted call can exhaust its original deadline at the same
dispatch stage on main. It does not recover the missing trace from the earlier fix2
run or claim identical failure rates. No dispatch code or assertion was changed.
Temporary logging and the two comparison worktrees were removed.

Logs are local files with the `/tmp/ci-flakes-24-fix3-` prefix:
`head-20.log`, `main-20.log`, `head-pinned20.log`, `main-pinned20.log`,
`head-loaded20.log`, `main-loaded20.log`, and `load-summary.log`.
`probe.patch` retains the exact temporary instrumentation. The audit search results
are `status-audit.txt`, `timeouts.txt`, `audit.txt` and `decision-callers.txt`.
Provider reproduction logs are `provider-before.log`, `provider-status-only.log`
and `provider-status-only-repeat.log`. Routine logs are `routine-red.log` and
`routine-green.log`.

### Own checks for this follow-up

Source: `231298d0443151d9ee819e83e04ef078d0e28dfe`. The following receipt-only
commit does not change tested code. Tests used the supplied PostgreSQL test service
on port 55432 and normal disposable NATS, PostgreSQL databases, OpenFGA and gateway
fixtures. All checks ran under `nice -n 10`. No full root suite was run.

| Check | Result |
| --- | --- |
| Full lint | PASS: 34 warnings, no errors |
| Full typecheck | PASS |
| Event catalogue | PASS: 157 event types agree |
| Separate Knip, changelog lint and documentation checks | PASS |
| Routine regressions before the fix | FAIL as expected: all three returned 403 rather than 503 |
| Focused routine follow-up | PASS: 21 cases, including saved refusals and audit failures |
| First eight-file pass | FAIL: 218 passed, two decision-cost cases failed |
| Second eight-file pass | PASS: all 220 cases |
| First gateway/MCP/routine selection | FAIL: 26 passed, five routine fixture setup failures |
| Second gateway/MCP/routine selection | FAIL: 30 passed, one routine fixture setup failure |
| Provider status-only correction, twice | FAIL: both reach the stale exact-message assertion |
| Full root suite, live qualification and post-push CI | NOT RUN |

The eight complete files are integration access, memory delivery, decision cost,
fence, precedence and refusal, plus both authority files. The separate 31-case
selection covers every changed gateway and MCP test, the three remote reply modes,
the routine regressions and saved-refusal/audit cases. Every changed test ran twice;
the provider case still fails as described above. The changed gateway, MCP and
routine dependency assertions passed in both selections. Both unchanged authority
files passed twice. No retry erases an earlier failure.

The first complete pass failed the cold-model catch-up case with an event-store
`TimeoutError`, and the large-cache success case with 503 instead of 200. Both passed
in the second pass. Their success, timing, read-volume and money assertions are unchanged.
The selected routine failures occurred in `allocateRoutineRoot`, while preparing the
fixture and before reaching the changed dispatch helper. The first selection affected
Stop, Pause, Retire, Access and Expired model cases; the second affected Access alone.
The earlier focused run passed all of these refusal cases. No fixture assertion or
root-allocation check was changed. These setup failures remain recorded as FAIL.

Logs use the same `/tmp/ci-flakes-24-fix3-` prefix: `changed-1.log`, `changed-2.log`,
`selected-1.log`, `selected-2.log`, `lint.log`, `typecheck.log`, `events.log`,
`knip.log`, `changelog.log` and `docs.log`. Overall qualification is PARTIAL:
the status-only provider correction still needs an exact-message decision, and the
load and fixture failures above remain explicit. This is not a source-ready claim.

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
