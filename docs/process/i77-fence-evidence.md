# Live view waits for the next check when activity arrives

**Status: PARTIAL.** Recorded passing focused checks and partial root checks.
Fresh-install live qualification remains NOT RUN.
Build from main `12644d6` on 5 October 2026. Rebase onto `38345bc` for the harness
change, then onto `8b04883` for the provider change and `acaf496` for docs.
Add no dependency or event type. The last rebase changed no runtime or test code.

## Root cause

Report finished and failed turns on the conversation stream (`apps/server/src/chat/reports.ts:14`).
Watch the member, conversation and desktop grant streams (`apps/server/src/computers/view-access.ts:203-205` on main).
Reject new events other than five output reports with `Authority changed` (`libs/models/src/authority.ts:138-145`).
Treat that error as a denial and close with 4003/access_changed (`apps/server/src/computers/view-access.ts:76-85`, `view-lease.ts:179-182`, `view.ts:66-67,246`).
Reject new team events or unapplied team changes too (`libs/models/src/paying-group.ts:56-58,74-82`).

## What changes

Treat new events found during the final freshness check as unconfirmed access.
Give the check no extra lease time. Read the new events in the next check, 250 ms
later. Retry admission and upgrade checks for up to five seconds, as before.
Keep the existing denial reads before the final freshness check. This lets a real
removal close the view even when every check sees chat activity.

Try another team with desktop access while the access service applies a change
to the first team.
Keep `Active silo membership required` as a denial.

Extend a lease only after a successful check, to its start time plus 1,500 ms.
Give a success handled after 1,200 ms no lease time. Check the lease before sending
every desktop byte. A revocation stored at time R therefore stops bytes by
R + 1,500 ms. A check starting after R reads the removal and denies access.
If the read of the removal is itself unavailable, stop bytes by the same bound
and close with 4503 after ten seconds without a lease, as before.

## Failing-first and branch results

Test HTTP admission, WebSocket access, lease notices, stored audit events and
fixed timing records through the real fixture services. Append after `head()` reads
the starting event number, or before it reads the conversation's latest event
number. Keep the real store reads.
Measure each close from the resolved append to the socket's close event.

Record the final baseline as 24 failed and 8 passed out of 32 cases on `38345bc`,
with product code unchanged. Twenty activity cases fail as expected. Four final-read
revocation cases also fail the new unavailable-record assertion, while all their
close code, reason, audit and two-second assertions pass. The eight remaining
guards and message checks pass.

| Test | Main | Branch |
| --- | --- | --- |
| agent.turn_started at last conversation read | FAIL | PASS (all 3 runs) |
| agent.turn_completed at last conversation read | FAIL | PASS (all 3 runs) |
| agent.turn_failed at last conversation read | FAIL | PASS (all 3 runs) |
| agent.turn_stop_requested at last conversation read | FAIL | PASS (all 3 runs) |
| message.posted at last conversation read | FAIL | PASS (all 3 runs) |
| file.uploaded at last conversation read | FAIL | PASS (all 3 runs) |
| file.delivered at last conversation read | FAIL | PASS (all 3 runs) |
| participant.added for bob at last conversation read | FAIL | PASS (all 3 runs) |
| participant.removed for bob at last conversation read | FAIL | PASS (all 3 runs) |
| file.rejected at last conversation read | FAIL | PASS (all 3 runs) |
| Another member's desktop grant at starting head | FAIL | PASS (all 3 runs) |
| Alice's role change keeps access | FAIL | PASS (all 3 runs) |
| Turn report during admission | FAIL | PASS (all 3 runs) |
| Turn report during upgrade | FAIL | PASS (all 3 runs) |
| Turn report during first lease check | FAIL | PASS (all 3 runs) |
| Another member joins the team during a check | FAIL | PASS (all 3 runs) |
| IAM applies another member's team join after one second | FAIL | PASS (all 3 runs) |
| Alice leaves the team during a check | PASS | PASS (all 3 runs) |
| Second granted team confirms while the first waits for IAM | FAIL | PASS (all 3 runs) |
| grant.revoked at starting head | PASS | PASS (all 3 runs) |
| grant.revoked at last conversation read | FAIL; close PASS, unavailable record absent | PASS (all 3 runs) |
| participant.removed at starting head | PASS | PASS (all 3 runs) |
| participant.removed at last conversation read | FAIL; close PASS, unavailable record absent | PASS (all 3 runs) |
| conversation.closed at starting head | PASS | PASS (all 3 runs) |
| conversation.closed at last conversation read | FAIL; close PASS, unavailable record absent | PASS (all 3 runs) |
| member.removed at starting head | PASS | PASS (all 3 runs) |
| member.removed at last conversation read | FAIL; close PASS, unavailable record absent | PASS (all 3 runs) |
| Grant revoked while every check sees chat activity | FAIL | PASS (all 3 runs) |
| Grant revoked during upgrade at starting head | PASS | PASS (all 3 runs) |
| Grant revoked during upgrade at last conversation read | PASS | PASS (all 3 runs) |
| Timing record says unavailable / authority_changed | FAIL | PASS (all 3 runs) |
| Shared freshness check throws the exact Authority changed message | PASS | PASS (all 3 runs) |

Keep earlier attempts separate from the final baseline. Install the repository's test
tools after the first attempt found no `.tools` directory. Correct rejected fixture
fields and reuse the admission cookie. The first usable full run had 25 failures and
7 passes. Its final-read upgrade guard also timed out alone: parallel grant reads
had finished before the injected append. Order the fixture's sibling heads after
that append so the intended check sees it. Keep every guard assertion unchanged. An early five-case fix run had two failures
from the same fixture ordering and overlapping appends. Serialise persistent test
appends and order every sibling head before rerunning the final checks.

## Revocation timings

| Guard | Main (ms) | Branch run 1 (ms) | Branch run 2 (ms) | Branch run 3 (ms) |
| --- | --- | --- | --- | --- |
| Alice leaves the team | 10 | 171 | 157 | 219 |
| grant.revoked at starting head | 11 | 11 | 16 | 18 |
| grant.revoked at last conversation read | 12 | 236 | 209 | 197 |
| participant.removed at starting head | 24 | 223 | 206 | 162 |
| participant.removed at last conversation read | 9 | 215 | 152 | 169 |
| conversation.closed at starting head | 18 | 241 | 207 | 187 |
| conversation.closed at last conversation read | 15 | 168 | 196 | 189 |
| member.removed at starting head | 29 | 244 | 219 | 247 |
| member.removed at last conversation read | 20 | 250 | 265 | 191 |
| Grant revoked during continuous activity | FAIL before revoke | 218 | 140 | 281 |

## Source checks

Run checks under `nice -n 10` with
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.

| Check | Result | Evidence |
| --- | --- | --- |
| Dependency installation | PASS | `nice -n 10 npm ci` |
| Failing-first behaviour run | PASS | Main: 24 failed / 8 passed as expected; four failures concern timing records only |
| New activity tests, three consecutive branch runs | PASS | 32 passed in each run; 96 passes total. Revocations: 11–281 ms |
| Lint | PASS | Complete expanded command on acaf496, including this receipt |
| Typecheck | PASS | All workspaces on 8b04883 |
| Event catalogue | PASS | 95 types on final main and branch; earlier base had 89. Add none in this fix |
| Focused live-view, lease, delivery, screenshot and group tests | PASS | Final combined run on 8b04883: 235 passed / 1 opt-in skipped across 16 files; earlier run 234 passed / 1 skipped |
| Model authority and decision tests | PASS | Included in final focused run; authority-volume also PASS; opt-in real-provider call test NOT RUN |
| Earlier full root suite on 38345bc | PARTIAL | 1,637 passed / 15 skipped; gateway suite failed with NATS heartbeats missed; single-worker retry: 80 passed / 1 opt-in skipped |
| Full root suite on 8b04883 | PARTIAL | 1,718 passed / 1 failed / 15 skipped; integrations Chromium status wait timed out; isolated single-worker retry PASS |
| Allowed file list | PASS | Seven allowed files only |
| Fresh-install live batch | NOT RUN | Orchestrator's plan below |

Ran the full root suite on `38345bc` with
`npm test -- --maxWorkers=2 --reporter=default`. Used the reporter option only to
show progress. Started at 08:05 UTC, with load 10.28 and no live qualification
process. Finished in 1,436.18 seconds. Recorded 102 passed files, one failed file
and four skipped files. All 1,637 test cases that ran passed; 15 opt-in cases were
skipped. Recorded the gateway suite failure: `JetStreamError: heartbeats missed`
from the NATS consumer heartbeat monitor. Kept that failure visible after the
single-worker retry passed. All 32 activity cases also passed in this root run.
Reran the gateway file alone with one worker: 80 passed and one opt-in case skipped
in 427.72 seconds. Marked the root check PARTIAL, not PASS.

Rebased onto `8b04883` after those root checks. Reran lint, typecheck, the catalogue
and all focused view and model authority/decision files on that base. Recorded
235 passed and one opt-in case skipped in the final focused run. Ran a fresh
full root suite on this base. Kept the earlier measured root result as PARTIAL.

Ran the final full root suite on `8b04883` with two workers. Started at 08:51 UTC,
with load 6.60 and no live qualification process. Finished in 1,524.40 seconds.
Recorded 104 passed files, one failed file and four skipped files: 1,718 passed
cases, one failed case and 15 skipped cases. The integrations Chromium journey
failed at `apps/server/test/integrations.test.ts:287`: after ten seconds of status
checks, the page still lacked "A scoped validation connection is required."
All view and model authority/decision tests passed. Reran the browser case alone
with one worker: one passed and 20 other cases were filtered out, in 37.66 seconds.
Marked the full root check PARTIAL, not PASS. Kept the full-run failure visible.

Rebased finally onto the docs-only `acaf496`. Runtime and test sources did not
change. Reran the expanded lint command for that commit and this receipt: PASS.

## Live qualification

Run the next live batch only after this change and the harness change have merged
and main CI is green. Follow the orchestrator's next-live-batch plan in
`/home/jente/.fleet/prompts/i77-fence-spec.md` and record results in
[i77-live-view.md](i77-live-view.md). Use a fresh secondary stack, ten counted runs
at alternating phone and desktop widths, and a quiet host. Require no early 4003,
no 4503 and every revoke-to-clear time at or below 2,000 ms. Record activity-check
results, pauses and host pressure. Tear down the stack and keep its receipt.
Do not count a source test as a live run.

## Not in this change

- Leave false refusals in model and MCP decisions for a separate change.
- Keep matching `Authority changed` by exact message until a typed
  `AuthorityChanged` error replaces it.
- Leave the decision audit row written before the last freshness check
  (`libs/models/src/decision.ts:183-194`).
- Keep screenshot capture during a busy turn able to answer 503 Retry.
- Leave the fresh-install live batch to the orchestrator.
