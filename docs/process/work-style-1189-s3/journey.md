# Model library style check

Journey on a fresh dev stack: PASS

The checked product commit is `071cec7074ef9e6214690e5adc8c30c5b34cf81c`.
The final receipt commit adds documents and pictures only. CI, image approvals
and the running product checks below apply to that product commit.
Date: 28 November 2026. The host ran Node 22.23.3.

## Fresh installation

Slot 1 stayed free, no competing package container was running, and the one-minute
load stayed below 6 for 300 seconds before the claim. Eleven samples had a maximum
load of 5.78. The live pilot was excluded. Every stack command used `DEV_STACK_ID=1`
and `--id 1`. The existing private sign-in key was supplied by path only.

`infra/dev-stack/up.sh --fresh --id 1` exited 0. Startup, CORE and the loopback
listener check produced 37 passing checkpoints. Playwright used real browser
contexts at 1280 and 390 px. Status then showed 14 running processes, seven Compose
containers and five healthy endpoints.

All eight selected pictures and 16 service logs were copied before teardown.
`infra/dev-stack/down.sh --id 1` was invoked. Its shell wrapper ended with signal
143 before printing a result. The later status command exited 0 and reported
`free`; no slot-1 Compose containers remained. Cleanup is complete. The wrapper
exit remains a PARTIAL command result rather than a claimed clean exit.
The [result counts](result.json) record the load check, source checks and cleanup.

## What the person did

1. The owner and member signed in through Zitadel in separate browser contexts.
   Wrong-organisation, expired-session and hostile sign-out checks passed.
2. The member sent messages at both widths. Replies streamed, survived reload
   and appeared once. Stop kept the partial reply after reload.
3. The member uploaded a PDF and asked for its project code. Scanning, extraction,
   the Willow-47 answer, reload and PDF, text and image previews passed.
   EICAR files, unsupported types and oversized files were refused.
   The existing driver used one upload retry per width and no preview retry.
4. The person opened the computer view. Assistant replies, removal, suspension,
   wake-up and Pod replacement passed. The computer kept its disk.
5. Another member and the owner could not read private action history. The owner
   could read organisation metadata without private text. Checks for private text
   in process and model logs passed at both widths.
6. The owner saved paying-group and assistant monthly limits at both widths.
   Over-limit calls were refused without a reservation and stayed refused after reload.
7. Sign-out, the next credential check, token privacy, member replay and catalogue
   replay passed. The browser closed before the read tables were rebuilt.

The optional long-chat approval journey was NOT RUN. Default CORE skips it.
A packaged browser installation was NOT RUN; this slice requires fresh CORE.

## Pictures

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Reply, reload and Stop | [Desktop chat](workspace-1280.png) | [Phone chat](workspace-390.png) |
| File ready | [Desktop file](upload-ready-1280.png) | [Phone file](upload-ready-390.png) |
| PDF answer | [Desktop answer](upload-1280.png) | [Phone answer](upload-390.png) |
| Monthly-limit refusal after reload | [Desktop refusal](budget-refusal-1280.png) | [Phone refusal](budget-refusal-390.png) |

The pictures contain generated test data. All eight were checked for credentials,
private paths and email addresses. CORE also changed older receipt files.
Nineteen tracked originals were restored after private copies were saved; two new
generated files were moved to private storage. Raw logs stay on the box only.

## Source checks

| Check | Result |
| --- | --- |
| Models package tests in CI on the product commit | PASS: 2,850 checks in 107 files; two optional checks NOT RUN |
| Package Vitest checks in CI on the product commit | PASS: 260 checks in 20 files |
| Infrastructure Node contracts in CI | PASS: 2,362 checks, including the package checks |
| Initial local focused checks | PASS: 253 checks in nine files |
| Pre-final local package Vitest run | PASS: 260 checks in 20 files |
| First local package Node batch | FAIL: 809 passed and six failed in 19 files |
| Complete affected preparation file, run alone | PASS: all 19 checks |
| Broad local models and combined package attempts | PARTIAL: stopped without final reports; full CI supplies the complete package evidence |
| Full typecheck on the product commit | PASS: all workspaces, package and dev-stack code |
| Event catalogue | PASS: 175 event types agree |
| Changed-file ESLint | PASS: 17 source files, zero warnings |
| Knip | PASS; two existing configuration hints |
| Whole-stream-read check | PASS: 305 known reads and five rebuild reads; no new read |
| Final receipt Markdown, changelog, privacy and secret checks | PASS |
| Separate web tests and build | NOT RUN as separate local gates; no web source changed |

The two optional models checks are paid OpenAI calls (`MODELS_REAL_CALL`) and
standalone native consent capture (`CODEX_CAPTURE_IMAGE`). Neither was enabled.
No test source changed. Existing tests pin the behaviour; this cleanup adds no
new behaviour that needs a new failing regression test.

The first broad local attempt lacked the pinned gateway binary link. The link
was added and the pinned tools were checked. A later attempt was stopped when
remaining schema chains were corrected. The final duplicate local batch was
stopped after full CI passed for the exact product commit, to free the shared
host for CORE. These incomplete runs are not counted as passing package runs.

The first local Node batch overlapped other checks under host load above 10.
Five preparation cases exceeded their existing 30-second process deadline; a
sixth failed while removing its temporary directory. All 19 cases in that file
then passed when run alone. No code, assertion or timeout changed for that run.

The first CI attempt failed one unchanged server fixture during cleanup after
its OpenFGA outage refusal checks. The server exceeded its existing one-second
shutdown grace. Rechecking the failed shard on the same commit passed. All CI
jobs and the test-file coverage check are green. No timeout or assertion changed.
No independent review was run by this builder.

[CI](https://github.com/elewa-git/opencrane-new/actions/runs/46161263353),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/46161258822)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/46161261392)
passed for the product commit. Both approval artifacts and both image artifacts
were present and unexpired before the claim.

## Code cleanup and work log

- Installed local dependencies and linked the pinned tools.
- Checked the date window and open pull requests, then selected unshared files.
- Split identity request construction into a small named function. Shared the
  approval turn-id parser and the repeated stage-number and digest validators.
- Named schema and command inputs, separated encoding steps and expanded refusal
  checks. Removed the inline builders and repeated parser definitions they replace.
- Passed source checks and CI, obtained image approvals, ran fresh CORE, copied
  the evidence and released slot 1. The worktree remains available for review.

The diff has 424 added plus deleted shipped-code lines across 17 source files.
No dependency, event or public API name changes. No size limit was raised.
The [scope list](scope.json) records 56 source files skipped for open-PR overlap,
23 other window files and the older parts of four partially cleaned files.
Package responsibilities and processes are unchanged; both README files are
shared with open pull requests and were left for the follow-up work.

Private raw files include `startup.log`, `status-after-core.log`, `teardown.log`,
`status-after-down.log`, `load-wait.jsonl`, `package-node.log`,
`prepare-routes-isolated.log`, `vitest-final.log` and `ci-shard3.log`.

## First review fixes

The remote 401/403 refusal and the unknown decision-error return now use braced
blocks. The personal-key comment explains why the profile lock is held: access
must not change before the verified key is staged. No behaviour changed.

Three temporary source checks first failed for these three findings. Their failing
version was committed before the fixes. After the fixes, both focused runs passed
all 61 checks in four files (53.25 and 65.01 seconds). These runs included the
existing decision-refusal, bearer-identity and bearer-connection tests. The temporary
checks were then removed; the existing behaviour assertions were unchanged.

Local gates: PASS for full typecheck, the event catalogue, Knip, changed-file
ESLint with zero warnings, changelog, Markdown, public privacy and secret scans.
Knip reported two existing configuration hints. All tests, lint and typecheck
commands ran under `nice -n 10`. The source edits were checked against the
engineering standard's cleanup table; no limit or assertion was loosened.

The fresh-stack journey was NOT RUN again because these fixes only change braces
and a comment. The earlier fresh-stack PASS applies to the product commit named
above. No secondary stack was claimed for these fixes.
