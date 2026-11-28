# Development stack style check

Journey on a fresh dev stack: PASS

The checked product commit is `e5feab8a6e7bd7a3bd2a6701e868e257ed79887f`.
The final receipt commit adds documents and pictures only. All source checks,
CI and image approvals below apply to that exact product commit.

## Fresh installation

Slot 1 was free, no competing package container was running, and the one-minute
load stayed below 6 for more than five minutes before the claim. The live pilot
was excluded. Every stack command used `DEV_STACK_ID=1` and `--id 1`.
The existing private sign-in key was supplied by path only.

`infra/dev-stack/up.sh --fresh --id 1` exited 0. It reported three passing startup
checks and 34 passing CORE checks. The real browser ran at 1280 and 390 px.
Status then showed 14 running services and five healthy endpoints.
Logs and all eight selected pictures were copied before teardown.
`infra/dev-stack/down.sh --id 1` exited 0, and status reported `free` afterwards.
The [result counts](result.json) include the times and the load check.

## What the person did

1. The owner and member signed in through Zitadel in separate browser contexts.
   Wrong-organisation, expiry and hostile sign-out checks passed.
2. The member sent messages at both widths. Replies streamed, survived reload
   and appeared once. Stop kept the partial reply after reload.
3. The member uploaded a PDF and asked for its project code. Scanning, extraction,
   the Willow-47 answer, reload and PDF, text and image previews passed.
   EICAR files, unsupported file types and oversized files were refused.
   The existing driver used one upload retry per width and no preview retry.
   This change adds no retry.
4. The person opened the computer view. Assistant replies, removal, suspension,
   wake-up and Pod replacement passed, including preservation of the computer disk.
5. Another member and the owner could not read private action history. The owner
   could read organisation metadata without private text. Member refusals and
   the checks for private text in process and model logs passed at both widths.
6. The owner saved paying-group and assistant monthly limits at both widths.
   Over-limit calls were refused without a reservation. The refusal stayed after reload.
7. Sign-out, the next credential check, token privacy, member replay and catalogue
   replay passed. The browser closed before the read tables were rebuilt.

The optional long-chat approval journey was NOT RUN. Default CORE explicitly
skips it. A packaged browser install was NOT RUN; this slice requires fresh CORE.

## Pictures

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Reply, reload and Stop | [Desktop chat](workspace-1280.png) | [Phone chat](workspace-390.png) |
| File ready | [Desktop file](upload-ready-1280.png) | [Phone file](upload-ready-390.png) |
| PDF answer | [Desktop answer](upload-1280.png) | [Phone answer](upload-390.png) |
| Monthly-limit refusal after reload | [Desktop refusal](budget-refusal-1280.png) | [Phone refusal](budget-refusal-390.png) |

The pictures contain generated test data. All eight were checked for credentials,
private paths and email addresses before committing. CORE also changed pictures
in older receipt folders. Those outputs were kept privately and the tracked
originals were restored. Raw logs remain on the box only.

## Source checks

| Check | Result |
| --- | --- |
| Existing focused checks after refactoring | PASS: 82 checks |
| Changed budget test file | PASS twice: 10 checks each; PASS again after restoring the mutation |
| Money test strength | PASS: a one-cent change to restoration made the existing test fail |
| Package Node checks | PASS: 1,716 checks in 37 files |
| First package Vitest run | FAIL: 259 passed; one deadline test missed its expected home-read stage |
| Complete backup file, run alone | PASS: 24 checks |
| Complete package Vitest run with one worker | PASS: 260 checks in 20 files |
| Full typecheck | PASS |
| Event catalogue | PASS: 175 event types agree |
| Knip, changelog and Markdown | PASS |
| Scoped repository ESLint | PARTIAL: its configuration excludes infrastructure |
| Supplemental TypeScript ESLint | PASS: 13 changed helper modules, including size and complexity rules |
| CORE driver and budget-test lint comparison | PARTIAL: five and 25 existing findings respectively, unchanged |
| Public privacy and secret scan | PASS |
| Separate web tests and build | NOT RUN as separate gates; no web source changed |

The first broad run coincided with host load above 20. The unchanged backup test
stopped before the home read it expected to observe. Its complete file then passed
alone, and the whole package suite passed with one worker. No test assertion,
production code or timeout was changed to make that test pass.

One attempted unit-test command included `provider-journey.test.mjs`. That file is
a live packaged browser driver, and it refused the unclaimed slot. It was excluded
from unit-test commands. All 23 actual unit checks in that command passed.

The existing tests pin this change's behaviour. No new behaviour needs a
failing-first test. The changed test passes the same budget identities through a
named input. Changing the restored ceiling by one cent made it fail for the wrong
amount. The original source was restored byte for byte before the final test run
and the fresh journey. No independent review was run.

[CI](https://github.com/elewa-git/opencrane-new/actions/runs/46138382905),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/46138382638)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/46138385145)
all passed for the checked product commit before the claim. Both approval artifacts
and both image artifacts were present and unexpired.

## Code cleanup and work log

- Installed local dependencies and linked the shared tools.
- Checked the date window and open pull requests, then selected files with no overlap.
- Split audit navigation, log privacy, budget migration and refusal checks into named
  steps. Grouped related audit and budget identities into named input types.
- Shared the budget scope lookup and removed repeated inline predicates and the
  callback that only saved the namespace file. Expanded command inputs, control flow and comments.
- Passed the source checks, pushed the product commit, obtained CI image approvals,
  completed fresh CORE and released slot 1.

The change has 732 added plus deleted shipped-code lines. Tests, documents and
pictures are excluded. No dependency, event or product API name changes.
The [scope list](scope.json) names 41 remaining source files and every overlap
with open pull requests. The budget editor and failure-capture section and the
rest of the large CORE driver remain for another part. No size limit was raised.
The 13 changed helper modules pass 80-line functions, five parameters, complexity
15, depth four and 500-line files. The large CORE driver has no extra lines.

Raw files kept privately include `startup.log`, `status-after-core.log`,
`status-before-down.log`, `teardown.log`, `package-node.log`, `package-vitest.log`,
`backup-isolated.log`, `package-vitest-serial.log` and `budget-mutation.log`.
