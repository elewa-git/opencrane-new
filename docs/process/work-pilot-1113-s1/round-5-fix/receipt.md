# Draft navigation and assignment access

Journey on a fresh dev stack: FAIL. The separate development-stack journey
failed while opening Spending. The full packaged journey failed while sending
the member's first message at 1280 px. Source `8fd998ea9`, all CI jobs and both
image approvals are PASS. The separate fresh draft assignment check is PASS at
both widths. Its chat check is PASS at 1280 px and PARTIAL at 390 px after process
interruption. Production F1/F2 host qualification remains PARTIAL under the
accepted local exception.

## Finding and correction

23 November 2026. Opening an unassigned draft closed the assignment socket.
The later personal assistant assignment could not reach the page. The regression
failed with `selectedAssistantId` still null after navigation. The failing test
was committed before the fix (`99d3d3fed`).

`PersonalAssignment.openDraft()` now replaces the old subscription and resumes
assignment delivery while the personal assistant is absent. Tests cover navigation
both before and after the socket opens, refusal of another member's assignment,
access loss and page destruction.

The four executable callbacks in the packaged sign-in runner are declared before
their calls. The readability test first failed on the four reported lines.
Subscription fixtures now live in `test/support`.

The rebase onto main at `42a261e03` finished successfully. Source `8fd998ea9`
includes the reply fix and publication fix. Both image approvals passed for that
exact source, with [present and unexpired artifacts](image-approvals.json).
The source [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/45152157890),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45152147580)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45152152614)
all passed.

## Access evidence

PASS. The real NATS, PostgreSQL and OpenFGA fixtures include two active people
with distinct identity-provider subjects. A second silo has the same member id
with its own membership and assistant. The tests withhold an assistant without
`acts_for`, refuse expiry and organisation or silo changes during a subscription,
and refuse delivery when removal happens during a controlled pending read.
Membership is also checked before reading content.

Each guard was removed separately, its focused test failed, and the code was
restored. The [guard results](guard-checks.json) record all twelve probes.
The [guard source check](guard-source.json) confirms those files were unchanged
by the rebase; the passing suites were repeated on the rebased source.
Organisation, expiry and silo binding each produced an assignment frame that the
original guard refuses. The silo case keeps the member valid in both silos so a
separate membership refusal cannot conceal a missing binding check.

Replacing `timingSafeEqual` with ordinary hash equality fails the claim test.
The test checks that accepted and refused claims both call Node's constant-time
comparison with two 32-byte digests. It does not measure elapsed timing.

## Source checks

PASS under `nice -n 10`:

- Subscription and claim tests twice: 30/30 each.
- Provisioning and navigation tests twice: 15/15 each.
- Affected qualification tests twice: 9/9 each.
- Full workspace, package and development-stack typecheck on the rebased source.
- Event catalogue: 174 event types.
- Knip, changelog, Markdown, README structure and whole-stream-read checks.
- ESLint on changed application/test files and supplementary ESLint on the two
  changed infrastructure files, with no warnings.

Privacy and secret scans passed before the first source push. No full root test
suite ran locally. The private task receipt retains the failing regressions,
guard-removal output and passing checks. This receipt reports builder checks.

## Fresh packaged journey

FAIL. The fresh install used approved images for `8fd998ea9`, after checking that
both approval runs still had unexpired artifacts. Both slots were free and the
one-minute load remained below six for five minutes before slot 1 was claimed.
The private values file was supplied once, by path. Package startup used
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` for the documented local
host exception. Production F1/F2 qualification is PARTIAL.

The [package results](package-full-results.json) and
[browser results](package-full-browser.json) record the observed checks:

- PASS: six private configuration refusals and three saved-setting refusals
  before Helm, followed by fresh hardened install and readiness.
- PASS: wrong-organisation real sign-in at both widths creates no member or event.
- PASS: owner claim, wrong token, token reuse and Secure/HttpOnly sessions.
- PASS: owner and admin chats at 1280 and 390 px. The admin's initial unassigned
  workspace received its assignment without reloading.
- FAIL: the member's first send at 1280 px remained at recording status unknown.
  Conversation creation and all 50 creation-catch-up list reads returned 200,
  but no message request reached the server.
- NOT RUN: member 390 px and the dedicated delayed-draft case in this full run.
- PASS: package, slot and temporary identity-provider app cleanup.

The [failure screenshot](package-member-send-failure.png) masks the input. The
[safe diagnosis](package-failure-analysis.json) records three dispatcher restarts,
its last exit code of one and PostgreSQL connection timeouts. These observations
do not establish the cause. Logs and resource state were retained privately
before teardown. No access guard, timeout, money check or reply assertion was
changed to obtain a pass.

## Separate fresh draft qualification

Assignment delivery: PASS at 1280 and 390 px on a new fresh approved package.
Both pages first read an unassigned context and a disabled composer. Each used
New session, Ask your agent, Ctrl+N and Cmd+N before the coordinator appended the
delayed assistant event. Both then received a live assignment and enabled their
composers, with one initial context read and one document request. Neither page
reloaded or polled the context endpoint.

| Width | Before assignment | Usable draft | Recorded checks |
| --- | --- | --- | --- |
| 1280 px | [Unassigned](draft-unassigned-1280.png) | [Composer enabled](draft-usable-1280.png) | [PASS](draft-assignment-1280.json) |
| 390 px | [Unassigned](draft-unassigned-390.png) | [Composer enabled](draft-usable-390.png) | [PASS](draft-assignment-390.json) |

Chat: PASS at [1280 px](draft-chat-1280.png), with a completed reply. The 390 px
chat is PARTIAL: the qualification process exited with code 143 (signal 15)
before it recorded completion. The interruption cause is unresolved. The
[separate results](draft-qualification-results.json) preserve this distinction.
The owner chat passed at both widths in that run.

The fixture uses a temporary member who initially requests no automatic
assistant. It creates the delayed assistant through a conditional event append;
the ordinary dispatcher, projections, permission checks and computer startup
remain responsible for delivery. The full owner, admin and member journey
separately exercises ordinary automatic provisioning.

Current and previous-container logs, resource state and events were saved before
manual teardown. Package removal, slot release and temporary test-app deletion
all passed. Both slots reported free and the package namespace was absent.
The retained previous dispatcher log reports “EVENTS stream is incomplete” before
one restart. This does not establish a cause for the earlier member-send failure.

An earlier isolated attempt stopped before provisioning because the harness used
a visible textbox locator for a deliberately hidden disabled textarea. The
[selector attempt](draft-selector-attempt.json) records that failure and cleanup.
A local browser probe reproduced the missing match and verified the corrected
check of the textarea disabled property. No product assertion was weakened.

## Separate fresh development-stack journey

FAIL. After the required five-minute quiet window, the run claimed slot 1 and
started `up.sh --fresh --id 1` on `8fd998ea9`. Website readiness passed. The
launcher's core journey later failed in `loadBudgetEditor` with “Spending budget
editor did not load”. The [safe command result](compose-results.json) retains
the failed run separately from packaged qualification.

The budget and effect response arrays were empty. The failed page showed Budget
service unavailable, with no access-change notice. Preceding server budget reads
and writes returned HTTP 200. This evidence does not identify the cause. No budget
or access guard was changed, and the failed operation was not retried.

Startup and service logs, the safe editor-state record and failure diagnostics
were retained privately before `down.sh --id 1`. Teardown exited zero and both
slots reported free. The later explicit status and repeat journey commands were
NOT RUN because fresh startup failed.

A later targeted-run admission check was refused. The slot was briefly claimed
in error, then released before any startup command ran. The corrected attempt then
passed a new complete quiet window before claiming its slot.
