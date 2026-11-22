# Workspace output and chat completion

Journey on a fresh dev stack: FAIL

Date: 22 November 2026. Main reproduction: `d6c4299aa822ae4078cf2b3b4b29d7d6f4aa1b3f`.
Fixed computer source: `c359bb697`; final browser cleanup: `017fabb47`.
Both use the stand-in provider and real browser sign-in.

Ten-run proof: **PARTIAL, 7/10 complete consecutive CORE passes**, at both
widths. The complete runs contain 91 completed replies and zero unexpected
turn failures. Stopped for the requested four-hour reporting limit.
The headline FAIL applies to the incomplete required qualification, not to
the individual CORE passes. The full legacy image-release check also remains
FAIL, as described below.

## Cause and reproduction

Waited until both secondary slots were free, no packaged stack was running and the
one-minute load had stayed below 6 for more than five minutes. Started main fresh in
slot 1. Its first 390 px reply completed. The next reply failed before it reached
`agent.turn_started`, without reaching the viewer step. Saved worker, server, computer,
models and gateway logs before teardown. The worker handled `agent.turn_failed` and
the computer journal recorded `model_error`. The model gateway had handled only the
first reply. The browser showed [Reply failed](screenshots/main-reply-failed-390.png).
The [failure](logs/main-failure.txt) stopped CORE at the existing caret assertion.

The bridge reads artifact snapshots, attachment text and publication files through
`workspaceProcess`. Native executor `process/read.afterSeq` excludes the supplied
record. Its returned `nextSeq` names the next unread record. The bridge used that
next record as its exclusive cursor, skipping it. An empty poll followed by stdout
can therefore lose the whole output. A later poll can lose another chunk too.

On the idle main computer, 1 of 40 calls to `artifactSnapshot` failed with
`SyntaxError: Unexpected end of JSON input`; the other calls passed. The
[saved probe](logs/main-artifact-probe.jsonl) records every result. Missing snapshot
JSON makes turn preparation fail; missing publication JSON can fail completion after
reply text has arrived. The viewer is not required to trigger this defect.

A [native protocol comparison](logs/native-cursor-comparison.json) delayed Python
output until after an empty poll. Both runs using `nextSeq` lost stdout. Both runs
using `nextSeq - 1` kept it. The
[computer reports](logs/main-bridge-reports.json) show the successful first turn and
the next turn's failure before its start report.

The previous receipts do not retain the underlying computer exceptions, so their
exact causes cannot be proved retrospectively. The earlier server bridge
`TimeoutError` in the retained logs came from a NATS stream-info read. That poll
warning alone does not prove that a model request or desktop connection failed.

## Fix and source checks

Use `nextSeq - 1` for each following executor read. Keep the current output limit,
one-second poll, overall timeout, refusal checks and stdout/stderr handling.
No production timeout, retry or assertion changed. Reuse the same reader for all
callers; no new runtime dependency or abstraction was added.

- **PASS:** test-only commit `a762cd0c1` lost the complete snapshot and a later stdout
  chunk, as expected. [Failing tests](logs/red.txt).
- **PASS:** test-only commit `895f0af9c` exercised the real native executor. With the
  old cursor, a successful process returned empty bytes instead of `Willow-47`.
  [Native failure](logs/native-red.txt).
- **PASS:** 30 tests in five files, twice, including the real executor, attachment
  input, artifact files and turn publication. [First](logs/green-final-1.txt) and
  [second](logs/green-final-2.txt) final runs.
- **PASS:** [typecheck](logs/typecheck.txt), [event catalogue](logs/events.txt),
  [Knip](logs/knip-final.txt), [changelog lint](logs/changelog-final.txt),
  [changed-computer ESLint](logs/eslint-final.txt) and [Markdown](logs/markdown-final.txt).
- **PASS:** [computer typecheck](logs/typecheck-computer-final.txt) and
  [dev-stack typecheck](logs/typecheck-dev-stack-final.txt) after their final changes.
- **PASS:** native-test CI registration, failing first for the missing image-job
  entry, then passing twice. [Red](logs/fixture-registration-red.txt),
  [first green](logs/fixture-registration-green-1.txt),
  [second green](logs/fixture-registration-green-2.txt) and
  [ESLint](logs/fixture-registration-eslint.txt).

Repository ESLint excludes infrastructure. An extra typed comparison found the
[same nine existing findings](logs/infra-lint-comparison.json) before and after the
browser cleanup change, with no new findings. No lint rule or limit was changed.

All tests, lint, typechecks and builds used `nice -n 10`. No full root suite was run.
Website source was unchanged, so separate website tests and build were not required.

The native MCP fixture now supplies the required memory-free execution mode.
The private-capabilities check reuses `uploadComputer` and the authenticated bridge;
its obsolete direct private-socket driver was deleted. It still requires a completed
private reply, one model request and no tools. Both native fixtures passed twice.
Changed functions remain below 80 counted lines and five parameters. No size limit
was raised and no error catch was added to hide lost output.

## Computer image

Candidate: `sha256:efb2bce053bdd9645fdddd6a6ec47af602eb15599f24de22d1346eb6bd5250bc`.
Source matching, native MCP, private capabilities, custom exec, notice completeness
and all 394 runtime package licence checks passed.

Full legacy image qualification: **FAIL**. Its direct unauthenticated `/grant`
request expected success and received `{ "error": "control" }`. The current control
guard was unchanged. The throwaway namespace was deleted and the release tag was
not promoted. This candidate remains for qualification; this receipt does not claim
that full image release qualification passed.

## Live CORE qualification

The [first fixed run](logs/first-fixed-run.json), on a fresh slot 2 after a second
five-minute quiet check, completed 13 replies with zero unexpected turn failures.
Its six `agent.turn_failed` events were two deliberate Stops and four expected
budget refusals. The [turn export](logs/first-fixed-turns.jsonl) includes the matching
Stop requests and saved budget decisions.

Both browser viewer paths completed the reply while viewing and then revoked access:
[390 px](screenshots/first-fixed-viewer-390.png),
[390 px revoked](screenshots/first-fixed-revoked-390.png),
[1280 px](screenshots/first-fixed-viewer-1280.png) and
[1280 px revoked](screenshots/first-fixed-revoked-1280.png).

Full CORE nevertheless failed at its final `mcp-catalogue --verify` replay command's
existing 60-second limit. The prior browser, upload, viewer, lifecycle and budget
assertions passed. The batch stopped at that failure; no repeat was counted as PASS.
Logs and screenshots were copied before teardown. The slot was released successfully.

CORE now runs its existing token, logout and reauthentication assertions and closes
the browser before replaying projections. This stops browser polling during the
rebuild. The replay assertions and existing 60-second limit are unchanged.
The subsequent fresh run passed both replay checks.

## Repeated fresh runs

Waited for both slots and packaged stacks to be free again, then for the one-minute
load to stay below 6 for 323 seconds. [Quiet check](logs/quiet-preflight.txt).
Kept one secondary slot for the batch and reset it fresh before each full CORE run.
No full root suite or build was run alongside it. Spot checks found the other
secondary slot free and no packaged stack. The stack itself raises system load;
the [measured range](logs/load-summary.json) is retained with the quiet preflight.

[Per-run results](logs/series-summary.json) include completed replies, expected Stop
and budget refusals, unexpected failures and the dated viewer receipts at each width.
The [latest completed run ledger](logs/latest-complete-turns.jsonl) retains the
matching Stop requests and budget decisions.
The completed runs contain no `TimeoutError` entries in the saved server, dispatcher
or model logs. Their pod receipts all name the corrected computer image.

At both 390 px and 1280 px, the browser does the following:

1. Sign in, open the workspace, send a message and watch the reply finish. Reload.
2. Stop another reply and check that its partial text remains after reload.
3. Upload a PDF, send an attachment reply and check its content and previews.
4. Open the computer panel without a grant and check refusal. Grant access, open
   the real desktop, send the next chat reply with the viewer open and wait for Done.
5. Revoke access and check that pixels clear and the access change is audited.
6. Finish lifecycle, audit and budget checks, sign out, sign in again, then verify
   both projection replays and the stack listeners.

Latest complete run screenshots:
[390 px viewing](screenshots/latest-complete-viewer-390.png),
[390 px refused after revocation](screenshots/latest-complete-revoked-390.png),
[1280 px viewing](screenshots/latest-complete-viewer-1280.png) and
[1280 px refused after revocation](screenshots/latest-complete-revoked-1280.png).

| Run | Started UTC | Finished UTC | Full CORE | Replies completed | Unexpected failures |
| --- | --- | --- | --- | ---: | ---: |
| [1](logs/core-run-01.txt) | 16:40:25 | 16:59:49 | PASS | 13 | 0 |
| [2](logs/core-run-02.txt) | 16:59:53 | 17:19:46 | PASS | 13 | 0 |
| [3](logs/core-run-03.txt) | 17:19:49 | 17:37:42 | PASS | 13 | 0 |
| [4](logs/core-run-04.txt) | 17:37:46 | 17:58:15 | PASS | 13 | 0 |
| [5](logs/core-run-05.txt) | 17:58:19 | 18:16:48 | PASS | 13 | 0 |
| [6](logs/core-run-06.txt) | 18:16:54 | 18:33:40 | PASS | 13 | 0 |
| [7](logs/core-run-07.txt) | 18:33:44 | 18:50:58 | PASS | 13 | 0 |
| [8](logs/core-run-08.txt) | 18:51:02 | 19:00:18 | PARTIAL: task deadline | 8 | 0 |

Each complete run also contains two intentional Stops and four budget refusals.
A Stop counts as expected only with its matching request and `stop_interrupted`
reason. A budget refusal needs its matching saved `budget_exhausted` decision.
Viewer results count only when their receipt dates fall inside that run.

Runs 1 and 2 started at `017fabb47`; later runs started at `d94fa75f1`.
The computer reader and browser cleanup are identical throughout this series;
the intervening change registered the native test in its CI image job.

Required ten-run proof: **PARTIAL**. No incomplete attempt counts as PASS.
Copied all startup and service logs and all generated screenshots before every
fresh reset and before final teardown. Full worker, bridge, computer, models and
gateway logs remain in the task’s private receipt directory. The public receipt
contains the selected sanitised evidence. Final teardown and slot status are
recorded in [the cleanup receipt](logs/final-cleanup.json).

The [shipped-code count](logs/shipped-lines.json) is nine added/deleted lines under
the requested source paths, or thirteen including the image/build settings.
Reused the shared reader, authenticated computer fixture and existing browser
cleanup. Deleted the obsolete 109-line direct-socket driver. No new
runtime dependency was added. No production timeout, retry, refusal assertion
or size limit was relaxed.

CORE retains its existing approval-journey skip. Full root tests, paid-provider
checks and private-memory isolation qualification are NOT RUN. CI is not awaited,
following the task’s final draft-PR instruction. The worktree is retained.

Independent review is left to the orchestrator. No independent review pass is claimed.
