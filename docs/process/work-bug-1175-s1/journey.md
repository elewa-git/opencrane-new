# Workspace output and chat completion

Journey on a fresh dev stack: FAIL

Date: 22 November 2026. Main reproduction: `d6c4299aa822ae4078cf2b3b4b29d7d6f4aa1b3f`.
Fixed product source: `c359bb697`. Both use the stand-in provider and real browser sign-in.

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
  [changed-file ESLint](logs/eslint-final.txt) and [Markdown](logs/markdown-final.txt).

All tests, checks and builds used `nice -n 10`. No full root suite was run.
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
Ten consecutive complete CORE passes remain NOT RUN.

Independent review is left to the orchestrator. No independent review pass is claimed.
