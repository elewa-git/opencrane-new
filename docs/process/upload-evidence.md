# P2-6 upload evidence

## Custom exec host isolation — 4 October 2026

Source: `work/upload`, starting at `bb7af88`. The focused review receipt
`/tmp/upload-independent-host-env.log` proved that the JavaScript host inherited
UID 1000 and `PROXY_CALLER_TOKEN`, with `NoNewPrivs=0`. Shell isolation alone did
not qualify this boundary.

The new `apps/computer/test/exec-host.mjs` failed first with **1000 !== 1001**
(`/tmp/upload-host-boundary-red.log`). It installs a trusted probe at the native
host entrypoint in a disposable computer, checks the launch before executing the
real host, then requests the same custom `exec`/`tools.exec_command` shape as the
real PDF request. This does not substitute the shell executor for the host.

The shared native launcher now has two fixed targets. Both drop to UID/GID 1001,
clear supplementary groups and the environment, set `no_new_privs`, and install
S0.1b's socket/process-inspection-denying seccomp filter. Codex at UID 1000 starts
only an IPC connector; the root supervisor launches the relocated native host.
The compiler stays in a build stage. No runtime dependency or licence exception
was added. Model request construction and document context remain unchanged.

- **PASS** host boundary and PDF stub: `/tmp/upload-host-boundary-green.log`.
  UID 1001, `NoNewPrivs=1`, restrictive seccomp in addition to Docker's filter,
  exact non-credential environment, protected Codex/desktop files and process
  environments, and `EPERM` for IPv4, IPv6 and Unix sockets. The native host runs
  with the checked identity and the stub answers **Willow-47** from file content.
- **PASS** fresh and resumed gVisor image: `/tmp/upload-host-gvisor.log` and
  `apps/computer/.state/checks.json`. Both request real custom exec and inspect
  the native host's identity, environment and private filesystem view. Desktop,
  document conversion, hostile PVCs and network isolation also pass.
- The first gVisor run **FAIL**ed because the old fixture selected `stub-model`,
  whose Codex metadata does not enable custom exec. The fixture now selects
  `gpt-6.1-sol` through the same local stub; no external provider is contacted.
- **PASS** licence gate, 384/384 packages: `/tmp/upload-host-image.log`.
  Final source/content checks: `/tmp/upload-host-contents.log`; shell checks:
  `/tmp/upload-host-shellcheck.log`.
- Independent fix verification found no further production-code blocker. Its
  remaining qualification finding was the fixture model selection above.
  **PASS** two connector EOF/host-exit/restart checks:
  `/tmp/upload-host-lifecycle-review.log`. Cancellation during an executing
  JavaScript cell was not separately qualified.
- **PASS** lint (five existing warnings), workspace typecheck and event catalogue:
  `/tmp/upload-host-{lint,typecheck,events}.log`.

The first full root run **FAIL**ed with 1,145 passed, ten skipped and one
failure (`/tmp/upload-host-tests.log`). Both daily/monthly budget concurrency
cases passed. The failure was the gateway revocation latency assertion:
2,264 ms for event append, an already-refused request, projection work and a
second refused request. The diagnostic run measured actual first-refusal latency
at 97–171 ms and separately measured the projection and second request
(`/tmp/upload-host-gateway-diagnosis.log`). The unchanged two-second bound now
ends at the first refusal, which is when revocation has taken effect; both
before/after-projection 403 checks remain. No security timeout was widened.
The budget assertion now includes every response status/body if its earlier
six-versus-seven mismatch recurs. That mismatch did not reproduce in either the
full run or the diagnostic run, so no budget behaviour change is claimed.

**PASS** final full root suite on the final source: **1,146 passed, ten skipped**,
70 passed test files and two skipped. Command:
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2`.
Receipt: `/tmp/upload-host-tests-final.log`, 850 seconds. The independently
verified timing correction, both budget cases and the real-computer PDF upload
journey are included. Final changed-test lint/typecheck and Markdown checks also
pass (`/tmp/upload-host-gateway-lint.log`, `/tmp/upload-host-models-typecheck.log`,
`/tmp/upload-host-docs-final.log`).

Qualified and published image:
`sha256:2a387e36ff44f6bd75f80e2bcffe3b0f9443e601efab5051cb32b13d10a637b9`.
The registry release and qualification manifests, tracked sandbox template and
fresh/resumed receipt have the same digest. Publication log:
`/tmp/upload-host-publish.log`.

No paid turn was needed or sent. The owner stack and its main checkout were not
changed; all new execution evidence uses disposable computers and local stubs.

## Reliable document context — 4 October 2026

Source: `work/upload`, starting at `6ba292e`. No dependency was added.

### Diagnosis and regression

The 00:45 paid receipt records two admitted provider responses, both HTTP 200,
and two settlements totalling four cents. That turn was not blocked by model
request admission. The named receipt/log retain usage and the answer, not full
request bodies; this diagnosis does not claim otherwise. The earlier native
continuation captures show `exec` wrapping `tools.exec_command`, followed by a
disabled-host result. The original bridge explicitly set `code_mode_host = false`.

A disposable computer using the original bridge config reproduces the same
failure with the pinned Codex 0.159.2 binary: `additional_tools` advertises the
`functions` namespace with custom `exec`, and its continuation contains
`custom_tool_call_output.output: "code-mode host is disabled"`. The declaration’s
instructions expose `tools.exec_command` through that host. Normal shell
execution was present, but the route the model expected was disabled. These are
local computer tools, not MCP calls; the MCP per-tool policy was not involved.
Private reproduction: `/tmp/upload-disabled-host-requests.jsonl` and
`/tmp/upload-disabled-host-reproduced.log`.

The old stub invented a direct `exec_command` fallback after that refusal. It
now uses the native custom call and fails on the refusal. The existing real
computer upload test then failed with **PDF reading failed** instead of Willow-47:
`/tmp/upload-fix-tools-red.log`. Enabling the host exposed another concrete
boundary mismatch: successful native custom results contain an array of text
blocks, whereas both admission and the stub expected a string. The gateway
regression failed with 403 before accepting that recorded shape:
`/tmp/upload-fix-blocks-red.log`. Top-level custom/namespace declarations also
failed before the shared local-tool schema fix: `/tmp/upload-fix-schema-red.log`.
The existing `additional_tools` grammar was already accepted.

### Resulting behaviour and source proof

The computer enables its bundled code-mode host and normal shell tools. Tool
output defaults to 2,000 tokens; the model response ceiling remains 2,000 tokens.
The decision schema accepts local function/custom/namespace declarations in both
locations and string or text-block custom results. Hosted tools, unknown fields,
media and excessive output bounds remain refused; MCP policy is unchanged.
The [configuration reference](https://developers.openai.com/codex/config-reference)
and the pinned executable’s feature list informed the configuration check.

The server passes attachment metadata separately from the stored user message.
The computer bridge reads converted PDF text through the existing UID 1001
executor before starting the model turn. Context includes original and converted
paths, at most 32 KiB of valid UTF-8 text across attachments, and an explicit
untrusted-document label. Truncation and unavailable text are explicit. Reads
reject symlinks and non-regular files. Text documents use their original path;
formats without converted text retain their original path. The newest 100
attachments are listed; older omissions are counted without breaking the turn.

Red/green context receipts: `/tmp/upload-fix-context-{red,green}.log`,
`/tmp/upload-fix-context-invalid-red.log` and `/tmp/upload-fix-many-{red,green}.log`.
The five focused integration cases pass in `/tmp/upload-fix-focused-green.log`:
real Codex reads through `exec`, its native result reaches the stub, and a second
attachment turn answers from inline text in exactly one provider request.
The stub learns the code from document content, not the question. The browser
journey now asks the exact unmarked real-model question.

Independent review: two passes. The first found that rejecting 101 attachments
would permanently break later chat turns; the fix bounds metadata before sending
and reports omissions. The second found no remaining blocker. The three final
builder tests pass in `/tmp/upload-fix-many-green.log`.

### Live qualification and the single paid turn

The reviewed image is
`sha256:e584d4c58fbdc2d364572aae1ac767154657cabc9d4eb5274935116a5be04367`.
Build, licence/SBOM checks and the gVisor qualification all **PASS**, including
512 MiB operation, executor isolation, browser, MarkItDown, network isolation,
hostile PVC and saved-disk resume: `/tmp/upload-fix-image-reviewed.log`.

Owner takeover used main `down.sh`, `printf` to write the upload checkout marker,
`npm ci`, and upload `up.sh`. The warm sandbox templates were updated to the
reviewed image through the existing checked-digest admission. The overall
`up.sh` journey is **FAIL**: its final browser logout failed with
`net::ERR_NETWORK_CHANGED`, obscuring the earlier journey error. Private logs:
`/tmp/upload-fix-main-down.log`, `/tmp/upload-fix-npm-ci.log`,
`/tmp/upload-fix-owner-image.log`, `/tmp/upload-fix-owner-up.log` and
`.tools/upload-fixed-owner-diagnostics/`. This is not a full-stack journey pass.

The focused real-browser upload journey on that owner stack is **PASS**:
PDF → ClamAV → MarkItDown → inline context → Willow-47, reload, upload-response
loss with one retry and no duplicate, EICAR/type/size refusal, and promoted
PDF/text/image previews. One preview retry recovered from `ERR_NETWORK_CHANGED`.
Receipt: `/tmp/upload-fix-browser.log`; screenshots:
`/tmp/upload-fix-browser-screenshots/`.

Exactly **one** further real `gpt-6.1-sol` chat turn was sent, asking
**What is the project code in the attached PDF?** The displayed answer was:

> The project code is Willow-47.

**Correct: yes. Actual settled cost: 3 euro cents, below the 10-cent cap.**
The one provider request contained the converted text in its user input;
no file-reading call was needed. Input was 10,160 tokens, output 15 tokens,
reasoning 0, cached input 0 and cache-write input 10,157. HTTP status was 200.
The pre-generation token count and 2,000-token response bound allowed at most
five cents for that request. The independent ledger confirms one turn, one
unchanged 502-cent reservation and one three-cent settlement. No paid retry
was made. Receipt began at `2026-10-04T01:49:30.181Z`.

Private receipts: `.tools/upload-fixed-receipt.json`,
`.tools/upload-fixed-requests.jsonl`, `.tools/upload-fixed-responses.sse`,
`/tmp/upload-fix-real.log` and `/tmp/upload-fix-real-ledger.log`.

### Final checks and handback

- **PASS** lint: `/tmp/upload-fix-lint-reviewed.log` (five existing warnings,
  no errors); evidence Markdown rechecked in `/tmp/upload-fix-docs-final.log`.
- **PASS** workspace typecheck: `/tmp/upload-fix-typecheck-reviewed.log`;
  dev-stack TypeScript: `/tmp/upload-fix-infra-types.log`.
- **PASS** `check:events`: 81 registered event types,
  `/tmp/upload-fix-events.log`.
- **FAIL**, then affected cases **PASS**: with
  `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`,
  `npm test -- --maxWorkers=2` finished with 1,144 passed, ten skipped and two
  failures (`/tmp/upload-fix-tests-final.log`). The Chromium command exceeded
  180 seconds; the daily-budget concurrency case returned six cap responses
  instead of seven. The unchanged failed cases, including both daily/monthly
  variants, passed on the targeted rerun: three passed, 67 filtered out,
  `/tmp/upload-fix-failed-rerun.log`. No timeout or assertion was loosened.
  The full run was not green; the targeted rerun does not erase that result.
  All new attachment and request-shape cases passed in the full run.

Restoration used upload `down.sh`, `printf` to write the main checkout marker,
and main `up.sh --fresh`. The first fresh start refused an occupied port 43002
while shutdown finished. After the port cleared, the second fresh start
provisioned main successfully but its browser journey **FAIL**ed at
`browser-chat.ts:42`: waiting for **Stopped · partial reply kept** exceeded
30 seconds. This is a partial handback, not a fresh-install qualification pass.
Main is clean at `3972492d9eb556587bfa443b26e154b33e84f83b`; the marker contains
`/home/jente/dev/opencrane-new`. All eleven managed processes and the server,
OpenFGA, MinIO and tailnet HTTPS health checks are **PASS**. The restored provider
is the local stub. No further paid turn was sent.

Private handback receipts: `/tmp/upload-fix-upload-down.log`,
`/tmp/upload-fix-main-fresh.log`, `/tmp/upload-fix-main-fresh-first-failure.log`,
`/tmp/upload-fix-main-fresh-retry.log`, `/tmp/upload-fix-main-status.log` and
`.tools/upload-fixed-main-diagnostics/`. Generated browser screenshots were
preserved privately and removed from the source diff.

## One turn under the settled-cost cap — 4 October 2026

**Real-model answer: FAIL. Spending cap: PASS.** This authorisation permits
exactly one chat turn with at most **10 euro cents of actual settled cost**.
Reservations are temporary holds, not spend. The 502-cent reservation bug is
tracked separately in [issue #75](https://github.com/elewa-git/opencrane-new/issues/75)
and was not changed. The earlier three-cent turn belongs to the previous
qualification; this authorisation produced one new turn and no other paid calls.

Source: `work/upload` at `59a4be9`; warm owner stack on the shared tailnet dev box,
Zitadel organisation `393311211338337681`. Computer image:
`sha256:24298d7546b149db86b1ce26828576add20a96842b6d35084beeba3a3e2c2916`.

The browser uploaded the existing `project.pdf` fixture and sent exactly:
**What is the project code in the attached PDF?** The expected answer was
**Willow-47**, present in the PDF and absent from the question. The displayed
reply was:

> I’ll check the attached document for the project code.
> I couldn’t open the attachment because the file-reading tool is unavailable.
> Please paste the document text here, and I’ll identify the project code.

**Correct: no.** Neither provider request contained the converted PDF text.
The model completed the turn without the expected answer; no paid retry was
made. The one-shot browser harness routed only this attachment conversation to
`gpt-6.1-sol`, counted input tokens before generation and checked the remaining
actual-cost allowance against each response’s bounded cost. The normal gateway
still made its unchanged 502-cent reservations. No production code was changed.

| Provider response within the single chat turn | Input tokens | Output tokens | Reserved cents | Settled cents |
| --- | --- | --- | --- | --- |
| 1 | 10,021 | 115 | 502 | 3 |
| 2 | 10,151 | 56 | 502 | 1 |
| Total | 20,172 | 171 | 1,004 across two holds | 4 |

Both reservations settled; their sum is not the actual spend. The second
response included 21 reasoning tokens within its 56 output tokens. Cached input
was 0 then 10,018 tokens; cache-write input was 10,018 then 130 tokens.
The receipt began at `2026-10-04T00:45:32.236Z`.
Conversation: `1d6c8677-b538-403e-83f5-739d2f0d4315`.
Turn: `87b1fb18-8408-421b-85c5-f251592e125c`.
Provider usage and the event ledger agree on **4 settled cents**.
Private local receipt: `.tools/upload-settled-receipt.json`; log:
`/tmp/upload-settled-real.log`. Neither contains provider credentials.

### Owner-stack takeover and runtime preparation

Stopped `/home/jente/dev/opencrane-new`, wrote the upload path to `stack-owner`
using `printf '%s'` with no newline, and ran `npm ci`: **PASS**. Started with
`ZITADEL_KEY_FILE` pointing to the original checkout’s existing key; no secret
was copied or printed.

The first default `up.sh` journey **FAILED** before sign-in. An anonymous browser
check identified a stale generated Vite cache missing `auditResponseSchema`.
Stopped the stack, archived `apps/web/.angular/cache` under `/tmp`, and repeated
`up.sh`. This repaired sign-in; the browser completed a stub chat and Stop/reload
checks, then **FAILED** after 130 seconds waiting for PDF delivery at
`browser-upload.ts:46`. The event store contained `file.uploaded` but no
`file.delivered` for that conversation.

The warm stack had retained main’s computer image
`sha256:b2a2852e085fe852a61125f48258630ac284ab1090e35fcf235e9eed9b8a3994`,
which lacks this branch’s upload support. Updated only the affected member’s
Sandbox to the branch’s pinned image and replaced its Pod while retaining the
saved disk. The replacement was Ready with the expected digest; the paid
harness then delivered its PDF successfully before sending the question.
The complete default journey was not repeated after this runtime repair and
remains **FAIL**, not a fresh-install upload PASS.

Logs: `/tmp/upload-settled-main-down.log`, `/tmp/upload-settled-npm-ci.log`,
`/tmp/upload-settled-owner-up.log`, `/tmp/upload-settled-cache-down.log`,
`/tmp/upload-settled-owner-cache-fixed.log`; sanitised failure receipts:
`/tmp/upload-settled-owner-result.json` and
`/tmp/upload-settled-owner-cache-fixed-result.json`.

### Fresh handback to main

Stopped the upload stack successfully and restored
`/home/jente/dev/opencrane-new` in `stack-owner` using `printf '%s'`; the exact
bytes were verified. Main source: `b8aee57`. Its first `up.sh --fresh` **FAILED**
in the logout probe at `login for response body`: the SSO button was absent.
An anonymous browser check found main’s generated Vite cache missing
`approvalCardsSchema`; HTTP returned 200 but the sign-in screen was blank.
`status.sh` passed service health, which did not make the browser journey pass.
Stopped main and archived its generated Angular cache before repeating the
fresh handback. Logs: `/tmp/upload-settled-owner-down.log`,
`/tmp/upload-settled-main-fresh.log`, `/tmp/upload-settled-main-fresh-result.json`,
`/tmp/upload-settled-main-status.log` and `/tmp/upload-settled-main-cache-down.log`.

The cache-repaired `up.sh --fresh` also **FAILED**, before the journey: model
startup reported `Gateway stopped`, then the launcher timed out waiting for the
model gateway. Log: `/tmp/upload-settled-main-fresh-cache-fixed.log`; sanitised
result: `/tmp/upload-settled-main-fresh-cache-fixed-result.json`. A plain `up.sh`
was then used to recover services on that newly created installation.

The recovery run also **FAILED** its journey. It reached the mobile chat
screenshot, then reported `Real browser logout failed at login for fetch` with
`net::ERR_NETWORK_CHANGED` while waiting for the SSO button. This is the observed
failure; it is not recorded as an issue #70 authority-admission failure.
Logs: `/tmp/upload-settled-main-recovery.log` and sanitised
`/tmp/upload-settled-main-recovery-result.json`.

**Final restoration health: PASS; complete fresh journey: FAIL.** Main owns the
running stack with the exact no-newline marker, and its final `status.sh` exits
zero. Server, OpenFGA, MinIO and tailnet HTTPS report healthy. After cache repair,
an anonymous browser check returned HTTP 200, a visible SSO button and no page
errors. Logs: `/tmp/upload-settled-main-final-status.log` and
`/tmp/upload-settled-main-render.log`. Journey screenshots were saved under
`/tmp` and their tracked originals restored; main’s checkout is clean.

This update changes only this evidence document. **PASS**: receipt-total and
single-turn assertions, `git diff --check`, Markdown lint and local-link checks.
The full source test suite was **NOT RUN** again for this documentation update.
Neither issue #75 nor the failed paid-model behaviour was changed here.

## Rebase and capped qualification — 4 October 2026

**Overall: PARTIAL. Real-model requalification: NOT RUN.** That authorisation
allows one chat turn with a hard five-euro-cent cap and requires stopping if its
reservation would exceed that cap. The local preflight returned **502 cents**
for `reservationCents('gpt-6.1-sol', 2000)`. Admission reserves the full supported
1,050,000-token context at the long-context tariff; the computer proxy sets the
output bound to 2,000 tokens. No chat turn or provider request was sent, and no
credentials were read for this preflight. No reservation was actually created.
At that point, the previous three-cent failed turn was the only paid attempt.

| Requested evidence | Observed result |
| --- | --- |
| Planned question | What is the project code in the attached PDF? |
| Expected answer, present only in the test PDF | Willow-47 |
| Actual answer / correctness | No answer; NOT RUN because the reservation exceeds the authorised cap |
| Input / output tokens | 0 / 0; no provider request |
| Cost / authorised cap | 0 / 5 euro cents |
| Reservation preflight | 502 euro cents; refused locally before a chat turn |

Source: `4847297` rebased onto `origin/main` `b8aee57`, producing `ac5a8d2`.
The rebase completed, `origin/main` is an ancestor, and no rebase state remains.
Conflict resolution preserves main's audit routes/workers, budget attribution and
default-group migration alongside uploads and the custom-tool schema fix.

Source checks: **PASS** `npm run lint`, `npm run typecheck` and
`npm run check:events` (81 event types). With the disposable PostgreSQL service on
loopback port 55432, the focused upload, bridge-proxy and gateway run initially
had 72 passed, one failed and one skipped test. The upload fixture lacked the
personal paying group now required by main; it timed out waiting for turn
completion. Adding the same budget setup used by main's bridge tests fixed it:
all seven upload tests pass on rerun. The gateway and bridge-proxy suites passed
on the first run; the paid-provider test stayed skipped. Final lint/typecheck
were rerun after the fixture change and passed. The full suite was NOT RUN in
this requalification. No new dependency or runtime behaviour was added.

Local logs: `/tmp/upload-rebased-focused.log`,
`/tmp/upload-rebased-upload-fixed.log`, `/tmp/upload-rebased-lint-final.log`,
`/tmp/upload-rebased-typecheck-final.log` and `/tmp/upload-rebased-events.log`.

Owner-stack takeover: stopped `/home/jente/dev/opencrane-new` successfully,
wrote the upload worktree path to `stack-owner` with `printf '%s'` (verified no
trailing newline), and completed `npm ci`. The first `up.sh` launch failed before
the journey because this worktree has no `.keys/.zitadel-key`. The configured
launch used `ZITADEL_KEY_FILE` to reference the existing key in the original
checkout, without copying or displaying it. Services started, but the default
journey **FAILED** at `owner 390px login`: it could not find the SSO button on
the home page. This was not a readiness-only failure, so no journey retry was
made. This was a warm installation; it does not qualify a fresh upload journey.
Logs: `/tmp/upload-owner-main-down.log`, `/tmp/upload-owner-npm-ci.log`,
`/tmp/upload-owner-up.log`, `/tmp/upload-owner-up-configured.log` and the sanitised
`/tmp/upload-owner-journey-result.json`.

Handback: stopped the upload stack successfully and restored the original
checkout's owner marker with `printf '%s'`, again verifying the exact bytes.
The first `up.sh --fresh` in `/home/jente/dev/opencrane-new` **FAILED** at the same
initial SSO-button check, while the HTTPS endpoint returned 200. An anonymous
browser diagnostic found the concrete rendering fault: the generated Vite cache
for `@opencrane/protocol` lacked main's `auditResponseSchema` export. Stopped the
stack and removed only `apps/web/.angular/cache` in the original checkout before
repeating the fresh handback. This was a cache repair, not a readiness retry or a
source change. Failed-attempt logs: `/tmp/upload-main-handback-20261004.log` and
`/tmp/upload-main-handback-failure.json`.

The repaired fresh run also **FAILED**, later in the journey: both browser chat
widths completed, then `journey.ts:169` / `chat-journey.ts:32` timed out waiting
for the HTTP chat's first message delta. The event ledger records
`decision.recorded` with `request_refused`, not budget exhaustion. Four preceding
stub calls settled at one fixture cent each; these are not provider spend. No
further journey retry was made. Log: `/tmp/upload-main-handback-cache-fixed.log`;
sanitised result: `/tmp/upload-main-handback-cache-fixed-result.json`.

**Restoration health: PASS; complete fresh journey: FAIL.** The original checkout
owns the running stack, `status.sh` exits zero, and
`https://ocn-dev.tail00285e.ts.net/` returns HTTP 200. An anonymous Chromium check
confirms the SSO button renders after cache repair. The original checkout is
clean; journey-generated screenshots were retained under `/tmp` before restoring
the two tracked images. Health log:
`/tmp/upload-main-restored-status-20261004.log`. The requested complete handback
PASS and real-model PDF acceptance remain unproven.

## Completion work — 3 October 2026

**Overall: PARTIAL.** Upload and stub qualification are separate from the one
paid-model turn, which failed before reading the PDF. See its receipt below.
This is not a claim that the live-model acceptance condition passed.

Source: `work/upload`, rebased onto `origin/main` `cc8d8c0`; rebased back end
`ed00488` plus the integration change containing this receipt. Computer image:
`sha256:24298d7546b149db86b1ce26828576add20a96842b6d35084beeba3a3e2c2916`.
Environment: the shared tailnet dev stack, Zitadel organisation
`393311211338337681`, Node 22.23.3, PostgreSQL test service on loopback port 55432.
No dependencies were added in this integration.

The attach menu now sends raw files with progress, clear type/size/malware
refusals and idempotent retry. Uploads replay in the transcript and the session
panel's **Attached by you** group. Send waits for delivery; the bridge gives Codex
the attachment paths without changing the stored user message. PDF, text and image
previews read only promoted server objects. The PDF uses Chromium's native viewer
inside the existing Open Terminal-style modal; no computer preview route exists.

The implementation strengthens the previous storage order: the bounded upload
stays in memory until ClamAV returns clean. Neither quarantine nor promoted object
storage receives bytes before that verdict. A blocked-scanner service test observed
both buckets, and the new assertion failed before this change. Parser module
startup has a five-second deadline, followed by the existing 1.5-second inspection
limit; the cyclic-input and responsive-health checks remain in place.

Live qualification exposed an executor-cleanup failure that the earlier Docker
fixture missed: Kubernetes drops `CAP_KILL`, so signalling the tools UID from the
supervisor returned `EPERM` and stopped the computer after delivery. The same
upload test failed after adopting Kubernetes' exact capability set. Closing the
executor's input pipe now shuts it down on EOF without cross-UID signals. No
capability was added. Logs: `/tmp/upload-capabilities-red.log` and
`/tmp/upload-tests-final.log` (the complete run includes the capability-restricted fixture). Temporary diagnostics were removed.

The routed PDF read also exposed a strict request-schema mismatch: Codex sends an
`id` on `function_call_output`, which admission previously rejected with 403. The
optional string field is now accepted; a real-gateway regression proves the
continuation reaches the stub while an unknown field is still refused. Logs:
`/tmp/upload-continuation-red.log` and `/tmp/upload-continuation-green.log`.
The same boundary now accepts the documented reasoning continuation and assistant
message phase, including Codex’s `content: null` on reasoning items, retaining
strict unknown-field refusal. The proxy allows 2,000
output tokens, the existing admission ceiling, because reasoning and tool-call
syntax count towards that limit. The previous 128-token allowance was too small
for this workflow. These changes follow the
[Responses reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
and [token-counting guide](https://developers.openai.com/api/docs/guides/token-counting).
Red/green receipts: `/tmp/upload-reasoning-{red,green}.log` and
`/tmp/upload-output-cap-{red,green}.log` and `/tmp/upload-reasoning-null-{red,green}.log`. These runtime fixes followed the two
review passes; their regression tests and live receipts are separate evidence.

TDD receipts in `/tmp/upload-*-red.log` and corresponding green logs cover the
missing preview route, attach menu, progress/retry, delivery guard, long messages,
queued attachment controls and attachment-first session titles. The 49 browser
component tests include recovery when conversation creation succeeds but its
projection read fails. Two independent review passes for this integration completed:
pass one found two retry/message-length blockers; pass two verified both fixes and
reported no remaining blocker.

The fresh journey then exposed the documented history-scan ceiling in model
admission: reading unrelated events took 2,249 ms, beyond the unchanged two-second
authority fence. A gateway regression with 5,000 unrelated events returned
503 before the fix. Authority now reads the current member, assistant, conversation and resource-grant
streams plus team history. IAM handlers already enforce those exact entity
subjects. Independent reads and projection-receipt checks run together; facts retain
global sequence order and the same permission and freshness checks. Unrelated
audit, billing, computer and conversation traffic is excluded. Large entity/team
histories still need the deferred fenced IAM projection. A second red regression
adds unrelated chat traffic to the 5,000-event fixture.
The fresh stub installation seeds a 4,000-cent daily fixture ceiling through an event before the budget writer starts, leaving
room for fresh and warm Stop checks whose uncertain reservations remain held.
This does not change production defaults or the separate paid check's ten-cent cap.
The delay-injection tests pause the resource-grant read and retain both the
within-deadline revocation case and the over-two-second cases. Red receipts:
`/tmp/upload-authority-red.log` and `/tmp/upload-chat-history-red.log`. All seven
focused admission, revocation and freshness cases pass in
`/tmp/upload-authority-entities-green.log`. The expanded two-width journey reached
Pod replacement but exceeded its ten-minute outer deadline on the shared host; the
dev-only outer limit is now fifteen minutes. Per-step and admission deadlines are
unchanged.

The rebuilt image passed its source/routing comparison, OSI/DFSG licence checks,
gVisor/512 MiB check, executor isolation, sandboxed Chromium, offline MarkItDown
PDF/Office conversion, network restrictions, hostile-PVC probes and saved-disk
resume checks. Log: `/tmp/upload-image-qualified.log`.

### Final source gates

| Gate | Result |
| --- | --- |
| Clean `npm ci` after stack handover | PASS |
| `npm run lint` | PASS; five existing function-length warnings, two Knip configuration hints |
| `npm run typecheck` | PASS |
| `npm run check:events` | PASS; 78 event types |
| `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=1 --testTimeout=60000 --retry=1` | PASS before the final custom-tool schema addition; 67 files, 1,067 tests; 10 skipped |
| Final gateway suite, same PostgreSQL URL, `npm test -- libs/models/test/gateway.test.ts --maxWorkers=1 --testTimeout=60000 --retry=1` | PASS; 54 tests, one paid-call test skipped; 284.56 seconds |
| `npm run build -w apps/web` | PASS; existing initial-bundle and component CSS budget warnings |
| `npm run test -w apps/web -- --watch=false` | PASS; seven files, 49 tests |
| `npx tsc -p infra/dev-stack/tsconfig.json` | PASS |
| Independent UI integration review, second pass | PASS; both first-pass blockers resolved; predates the runtime fixes above |

The complete run before the custom-tool compatibility fix took 1,169.58 seconds with one test retry allowed. Earlier attempts under shared-host
load hit the existing 180-second browser-process deadline and admission timeouts.
The passing run used one worker with this worktree's dev stack stopped.
The later custom-tool schema change has its own red/green gateway regression;
its final gateway-suite and live receipts are recorded separately.

Main advanced during qualification. The final rebase incorporates its isolated
stack tooling and preserves a separate ClamAV port per stack. A Git tree comparison
confirmed that the rebase itself left `apps/`, `libs/`, root test scripts and
package/configuration files identical to that passing test run. The later
admission fixes are included in the final 1,067-test complete pass. The merged infrastructure has its
own TypeScript check, focused upload regression and live qualification. Secondary
upload journeys are NOT RUN; this receipt qualifies the tailnet owner stack.

Final lint, typecheck, event and infrastructure checks after the custom-tool fix
pass in `/tmp/upload-custom-{lint,typecheck,events,infra}.log`. The complete
repository test suite was not repeated after that three-line schema addition;
the complete affected gateway suite is checked separately.

Source logs: `/tmp/upload-report-final-tests.log`,
`/tmp/upload-report-{lint,typecheck,events,infra}.log`,
`/tmp/upload-web-{build,tests}-qualified.log`, `/tmp/upload-infra-rebase.log` and
`/tmp/upload-rebase-tests.log`. The exact Codex continuation fixture and focused
live browser proof pass, including nullable reasoning content and refusal of
unknown fields.

The first final gateway-suite run passed all 54 assertions but failed with an
unhandled NATS connection-closed error during teardown. The provider fixture had
started an admission-audit read without awaiting it before closing the store.
Cleanup now awaits those reads; this changes only the test fixture. Failed
receipt: `/tmp/upload-custom-gateway-suite.log`; rerun receipt:
`/tmp/upload-custom-gateway-final.log` (54 pass, one skip, no unhandled errors).
Final lint and model typechecking also pass in `/tmp/upload-final-lint.log` and
`/tmp/upload-final-model-types.log`.

### Dev-stack qualification

The main checkout was stopped before handover. The ownership marker then pointed
at this worktree and a clean `npm ci` passed. Qualification uses only the tailnet
owner stack and the pinned Zitadel organisation above.

| Run | Result | Receipt |
| --- | --- | --- |
| `up.sh --fresh` on `work/upload` (final application source) | PASS | `/tmp/upload-custom-fresh-final.log` |
| Plain `up.sh` on the same installation (final application source) | PASS | `/tmp/upload-custom-warm.log` |
| Main `f5e3068` restored with `up.sh --fresh` | PASS with the fixture settings below; default-launcher attempts failed | `/tmp/upload-main-handback-repeat.log` |

After the custom-tool schema fix, the final fresh run passes in
`/tmp/upload-custom-fresh-final.log`. Both widths use one deliberate response-loss
retry and no preview retries. Codex receives the custom-tool refusal, then reads
the MarkItDown file with the sandboxed shell before the stub answers correctly.
The final plain run also passes in `/tmp/upload-custom-warm.log`, with the same
one retry/no duplicates result at both widths and no preview retries. The status
receipt `/tmp/upload-custom-status.log` confirms healthy ClamAV, MinIO, server,
OpenFGA and tailnet HTTPS.

The final passing fresh run includes ClamAV and MinIO startup, both complete browser
upload journeys, the HTTP PDF journey, real Codex reading MarkItDown text,
EICAR/type/size refusal, idempotent retry, promoted previews, suspend/wake,
saved-disk Pod replacement, projection replay and tailnet listener checks.

Two warm attempts passed both browser upload paths, then their separate HTTP PDF
turns received a 403 on the model continuation after reading the converted text.
These failed journeys are not counted as PASS. Focused repetition reproduced a
freshness refusal: context reads took 1,571 ms, then reservation crossed 2,398 ms
without an authority-category change. Independent assistant, conversation,
active-turn and IAM reads had been sequential. A gateway regression with delayed
reads failed before they were run together, then passed alongside the revocation
checks. The two-second deadline and authority checks are unchanged. Red/green
receipts: `/tmp/upload-parallel-context-{red,green}.log` (five focused cases pass).
Budget append still scans its stream; high-volume operation retains that known
limit.

A further focused live reproduction identified a separate race: admission took
270 ms, but the PDF's `agent.command_ran` report advanced the conversation category
and caused refusal. A gateway regression returned 503 before the fix. Admission
now accepts only command, file, reasoning and message output reports across that
read; these reports grant no authority. It rechecks every category afterwards,
so a grant revocation during the report read still refuses dispatch. Stop,
conversation closure and participant removal remain refused, as does an expired
two-second snapshot. Red receipts: `/tmp/upload-command-race-red.log` and
`/tmp/upload-report-race-red.log`; regression and security receipt:
`/tmp/upload-report-security-green.log` (14 focused cases pass). That complete
run passes all 1,067 tests. Temporary timing diagnostics were removed.

The first complete run after the concurrent-read change passed 1,057 tests but
failed one existing gateway test during fixture startup (`Gateway stopped`),
before its request assertions ran. That case passed immediately in isolation
(`/tmp/upload-gateway-startup-repeat.log`). The complete rerun explicitly allows
one test retry; all 1,058 tests pass and the runner reports no failing case.
The first fresh start on this final source failed during initial owner sign-in
with Chromium `net::ERR_NETWORK_CHANGED`, before the upload journey ran. It is
recorded as a failed attempt, not a capability PASS (`/tmp/upload-final-fresh.log`).
Another attempt passed the PDF read but lost both text-upload responses. Browser
transport diagnostics then confirmed `net::ERR_NETWORK_CHANGED` during an upload
request. The journey now clicks the shipped Retry control at most twice, with a
one-second pause, for lost responses on both accepted and refused files. It never
retries a known refusal. The focused full mobile journey passes in
`/tmp/upload-transport-retry-final.log`; infrastructure types pass in
`/tmp/upload-final-infra.log`. These are test-harness changes only; the later output-report admission fix has
its own complete gate run.
The browser login fixture also retries only `ERR_NETWORK_CHANGED`, at most twice.
If credentials succeeded before the return navigation was lost, it first checks
the server session and reloads the home page. The existing identity, organisation,
cookie, remembered-account and refusal assertions remain in place.

The first fresh attempt after the output-report fix completed the PDF answer and
recovery path, then failed during the logout probes at `login for fetch`. It is
recorded as FAIL in `/tmp/upload-report-fresh-logout-failure.log`, not as a complete
stack PASS.

The first warm attempt on the final application passed its PDF turn, then reached
suspension before the separate `computer.turn_closed` event arrived. The turn
completed at 21:04:21; lifecycle closure was recorded at 21:04:22.757. The journey
now waits for all started turns to close before its unchanged suspension assertion.
This fixture-only wait was added after the passing fresh run; application source
is unchanged. Failed receipt: `/tmp/upload-report-warm-lifecycle-failure.log`.
Infrastructure typecheck: `/tmp/upload-lifecycle-infra.log`.

A later warm attempt stopped at an unavailable PNG preview; the server recorded
its GET with no completed HTTP response or recorded refusal. The browser fixture
now records preview transport errors and closes/reopens the preview at most twice
only for `ERR_NETWORK_CHANGED`. HTTP refusals and other failures still fail the
journey. Receipt: `/tmp/upload-report-warm-preview-failure.log`; infrastructure
types: `/tmp/upload-preview-final-infra.log`. The final fresh run with these changes passes in `/tmp/upload-qualified-fresh.log`: it
recovered a browser network change during sign-in and a mobile upload (two upload
retries at 390px, one at 1280px; no duplicate files). Both preview paths passed
without needing their transport retry. The final plain startup also passes in `/tmp/upload-qualified-warm.log`, on the
same installation: two upload retries at each width, no duplicate files, all
previews, lifecycle, replay, sign-out and listener assertions passed. The host was
under sustained parallel load; these receipts do not claim a latency SLO PASS.

The first warm start after that final fresh PASS exhausted the bounded sign-in
retries with `ERR_NETWORK_CHANGED` at the 1280px return navigation, before upload
or model turns. It is a failed attempt (`/tmp/upload-qualified-warm-network-failure.log`);
plain startup was retried on the same installation without application changes.

Another warm attempt completed upload, PDF, recovery and both projection replays,
then failed at the final form-sign-out probe. Its receipt is
`/tmp/upload-qualified-warm-logout-failure.log`. The fixture now reports only the
error class and its own source location for that failure, without provider URLs or
assertion values that could contain tokens. No sign-out assertion was removed.

After the custom-tool fix, the first fresh attempt passed the mobile custom-call
recovery/PDF path, then the desktop's initial chat send remained queued and its
streaming assertion timed out (`/tmp/upload-custom-fresh.log`). The next fresh
attempt stopped at model-gateway readiness; its process had exited during startup
(`/tmp/upload-custom-fresh-repeat.log`). Neither attempt is counted as a complete
fresh-install PASS.

The first two main-checkout handback attempts failed at the owner's 390px SSO
button, before chat qualification (`/tmp/upload-main-restored-fresh.log` and
`/tmp/upload-main-restored-fresh-repeat.log`). Browser diagnostics identified a
stale Angular/Vite dependency cache: the new budget UI requested
`budgetCommandSchema`, which the cached protocol module did not export. Both
Chromium variants reproduced the blank page. Main was stopped and only its
generated Angular cache was moved aside before the next fresh startup. Main
source was not changed. That run passed sign-in, then timed out opening the
workspace (`/tmp/upload-main-restored-final.log`). A separate signed-in browser
opened the workspace successfully with no JavaScript error; the full fresh check
was retried with the rebuilt cache intact.

The next main run reached chat but failed its unchanged partial-Stop assertion
(`/tmp/upload-main-handback.log`): the owner stub completed all three chunks before
the click took effect. Main already supports `MODEL_STUB_PAUSE_ON_STOP=1`, but its
launcher enables that flag only for secondary stacks. For handback qualification,
the owner stub was temporarily launched with that same existing flag. No assertion
or application behaviour was changed. The temporary launcher/readiness adjustments and the
journey's generated screenshots are restored afterwards; the live stub retains
the fixture flag until it is restarted. The main fresh result below therefore
qualifies this stated fixture configuration, not an unmodified default launcher.

That configured attempt timed out at the owner's 30-second joined-computer wait
(`/tmp/upload-main-handback-qualified.log`). The computers subsequently showed
Ready, with claim-to-Ready event times of roughly 28–29 seconds, excluding the join-to-claim
and projection catch-up time. The final handback
check uses main's existing secondary-stack fixture allowances: 90 seconds for
readiness and 600 seconds for the outer journey. Application/security deadlines
and browser assertions are unchanged. Both temporary fixture files are restored
after qualification; this does not claim an unmodified default-launcher PASS or
a latency SLO PASS.

The first run with those fixture allowances passed both browser chat paths and
suspension, then the resumed request failed with gateway HTTP 503 (`upstream call
timeout`), so its first-token check failed (`/tmp/upload-main-handback-final.log`).
Host load subsequently exceeded 24 on eight cores. Main's admission checks were
not relaxed. This failed run is not a handback qualification PASS.

The next fresh main run passes in `/tmp/upload-main-handback-repeat.log`, including
both browser chat paths, suspended-computer wake, replay, sign-out and listener
checks. The ownership marker is back at `/home/jente/dev/opencrane-new` (`f5e3068`).
Both temporary fixture files and the generated workspace screenshots were restored;
`git status --porcelain` is empty there. Main remains running with the stub's Stop
pause enabled. `/tmp/upload-main-restored-status.log` confirms healthy server,
OpenFGA, MinIO and tailnet HTTPS after restoring the files. A later default restart does not retain this qualification setup.

### Screenshots

The live browser selects files through the native attach menu, loses the first
upload response deliberately, then clicks Retry. It verifies one attachment after
retry and three after PDF/text/image uploads; refused files never appear. The
oversized fixture is a real sparse file selected by path, avoiding a 20 MiB copy
through Playwright. The earlier buffer fixture coincided with NATS timeouts that
stopped the projection workers and model service; that failed attempt is not a
capability PASS.

| Width | Upload | Promoted PDF preview |
| --- | --- | --- |
| 1280px | [Upload](../design/chat/live/upload-1280.png) | [Preview](../design/chat/live/preview-1280.png) |
| 390px | [Upload](../design/chat/live/upload-390.png) | [Preview](../design/chat/live/preview-390.png) |

All four images were visually inspected. The mobile journey measures at least
44px for Attach, Upload from computer, Retry, Open, Close and Download, checks the
session panel's attached group, and refuses horizontal page overflow. PDF/text/
image previews use the promoted object route; the downloaded PDF equals the
uploaded bytes.

### Not run

- Hosted CI and Git push; this work remains local as requested.
- Eight opt-in operations lifecycle tests and one opt-in server Kubernetes bridge
  test. The dev-stack journey separately exercises the real computer lifecycle.
- The models suite's opt-in three-paid-call check; the approved check is exactly
  one chat turn instead.
- Secondary-stack upload journeys and rendered Office previews. Offline Office
  conversion was checked in the image qualification.
- Paid requalification after the custom-tool fix: the approved single turn was
  already used, so another paid turn was not sent.
- A third independent review pass. The process permits two; runtime fixes found
  after those passes have regression and live evidence, not another review verdict.

### One real PDF chat turn

**FAIL — exactly one turn, no final answer.** At 21:55 UTC on 3 October,
the browser uploaded the test PDF and sent one question through routed
`gpt-6.1-sol`. The provider completed one response: 10,063 input tokens,
110 output tokens, zero reasoning tokens, zero cached input tokens and
10,060 cache-write tokens. The event ledger settled **3 euro cents**, below
the approved ten-cent limit. Conversation `af833af6-fc04-44ee-a11f-49968731db78`;
turn `318ebe13-8232-4da7-a266-c40c288458a7`.

The response attempted a custom `exec` tool call. The computer's deliberately
disabled code-mode host refused it; admission then rejected the custom-call
history before the model could recover with the sandboxed shell. No PDF text
reached the paid model, and no final answer was produced. The one-shot receipt
is retained privately in `.tools/upload-real-receipt.json`; no secret is included
here. The paid turn will not be repeated under this one-turn authorisation.

A failing gateway regression reproduces the rejected `custom_tool_call` and
`custom_tool_call_output` history. The strict schema now accepts those documented
items and still refuses unknown fields. The
[Responses tool guide](https://developers.openai.com/api/docs/guides/async-tool-calling)
confirms the call/output pairing. Red/green logs:
`/tmp/upload-custom-{red,green}.log`. The stub journey now emits a custom call
first, then a direct shell fallback; its answer still requires the actual
MarkItDown text in shell output. The code-mode host remains disabled. Paid
requalification after this fix is **NOT RUN**; the live-model outcome remains
FAIL, regardless of the stub result.

## Historical back-end evidence — 2 October 2026

The following receipt describes the previously reviewed back end. Its quarantine
order and outstanding-work list are superseded by the 3 October section above.

2 October 2026, `work/upload`, based on main `1138544`. Local source evidence;
this is not a fresh-silo capability PASS. No shared dev-stack process, container,
Pod, database, credential or signature was changed.

### Acceptance evidence

`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run apps/server/test/upload.test.ts`
passes against disposable MinIO and ClamAV, real NATS JetStream, an isolated
PostgreSQL database and disposable OpenFGA. The computer test uses the existing
`ocn-computer-runtime` image with this branch's sources mounted read-only, a
private saved-disk volume and the loopback stub provider. All fixtures are removed.

| Claim | Result / evidence |
| --- | --- |
| Authentication and origin | PASS: no cookie gives 401; wrong origin gives 403; other-owner participant, direct and closed conversation GET/POST refused; current membership and permissions checked in OpenFGA |
| Content and size | PASS: disguised executable/archive, encoded Excel macro declarations, macro sheets and encrypted/macro legacy workbooks refused; over 20 MiB gives 413; real PDF accepted |
| Quarantine before visibility | PASS: a blocked scanner leaves only a quarantine object, absent from the HTTP file list; an unavailable scanner returns 503 and removes quarantine |
| Infected upload | PASS: EICAR gives 422 with a clear refusal, records one `file.rejected`, removes quarantine and never promotes or lists the infected bytes |
| Replay and retry | PASS: projection rebuild produces the same HTTP list; same key/body succeeds once; changed body gives 409, including a concurrent race with one committed upload |
| Bridge delivery | PASS: authenticated bridge sends a file larger than one frame; real computer verifies, saves and acknowledges; server records `file.delivered` |
| Reconnect and saved disk | PASS: resend after disconnect and replacement of a disposable computer with its saved volume preserves original-file mtime; process pause/unpause also succeeds |
| PDF reading | PASS: real Codex requests `exec_command` to read MarkItDown's adjacent text; stub only answers Willow-47 after seeing that fact in tool output |
| Invalid acknowledgement | PASS: malformed JSON refuses delivery without an uncaught socket-handler error |
| Storage credentials | PASS: real upload path uses bucket-scoped STS; independent check refuses expired and overlong leases before storage I/O |
| FreshClam dev-box refresh | PASS: pinned engine updated a scratch candidate from daily 28046 to 28141; main 63 and bytecode 339 unchanged. Candidate is not deployed |
| Offline scanner | PASS: cleaned runtime scans a file with `--network none` and bundled signatures; neither UnRAR library exists in that runtime |

The scanner source is copied from OpenCrane 1 commit `10abd0ef6`, including its
AGPL licence. The pinned daemon source contains offline main 63, daily 28046 and
bytecode 339; no network update runs at daemon startup. See
[scanner notes](../../infra/clamav/README.md). The FreshClam candidate lives in
`/tmp/upload-signatures`; its updater log is `/tmp/upload-freshclam.log`.
The scanner runtime is flattened from that pinned source with both non-OSI
UnRAR libraries removed; its [licence review](../../infra/clamav/LICENCES.md)
records the bundled notices and Debian main boundary.

### Gates and remaining qualification

Fresh dev-stack upload/PDF journey, actual Kubernetes suspend/wake with this
change, hosted CI, real provider call and rendered Office previews are NOT RUN.
The shared stack is owned by another builder. Compose and journey code include
ClamAV, the files worker, PDF/stub proof, EICAR refusal and saved-PDF verification
after Pod replacement for a later fresh run. Issue #31 remains the live
qualification tracker; source readiness does not close it.

Local checks use this branch's source tree on main `1138544`; the final commit is
reported with the handoff. Clean `npm ci`, root lint/typecheck, infra TypeScript,
`check:events` (76 types), the web build and all 41 web tests passed. Lint has five
function-length warnings; the web build retains its existing CSS-budget warning.
Two independent review passes completed, and all three blocking findings were
fixed with regression or refused-credential evidence. Image licence inspection
also removed the upstream UnRAR plug-ins before qualification.

The initial concurrent full-suite runs hit five-second timeouts under host load,
and one provider-status fixture exceeded its internal timeout. The final suite
uses two workers and a 20-second default test deadline; production deadlines are
unchanged. PASS: `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --testTimeout=20000 --reporter=verbose`
finished with 63 passing files and 1,029 passing tests. Two live Kubernetes files
and the real-provider test were skipped (three tests); those conditions are NOT RUN.
Safe local logs: `/tmp/upload-final-tests-limited.log`,
`/tmp/upload-final-lint-retry.log`, `/tmp/upload-final-typecheck-retry.log`,
`/tmp/upload-final-web-build.log`, `/tmp/upload-final-web-tests.log`,
`/tmp/upload-clamav-build.log` and `/tmp/upload-offline-scan.log`.

### Dependency assessment

`npm audit --omit=dev` reports four moderate entries through MinIO: two affected
packages and their dependants. The
[URI-decoding advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)
requires decoding attacker-controlled input; this adapter uses the SDK's query
encoding calls, never its parsing API. The
[stream-json advisory](https://github.com/advisories/GHSA-528h-pc64-c93x)
affects nested-input filters; MinIO imports its JSON-line parser for bucket
notifications, which this adapter never invokes. Reviewed installed SDK sources:
`dist/esm/internal/client.mjs`, `helpers.mjs` and `notification.mjs`. These findings
are assessed as unreachable from uploaded bytes on the shipped path, not fixed
upstream. No runtime high/critical finding is reported. The full audit additionally
reports the existing Angular build/Piscina critical findings; this change does
not alter those build-only dependencies.

### Independent review pass 1 fixes

2 October 2026, source parent `114c2a3`, follow-up on `work/upload`. The
reviewer's two blockers were reproduced before each fix. These runs used the
same disposable service/computer fixtures described above and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. The shared dev
stack was untouched. This follow-up awaits independent review pass 2.

| Proof | Before fix | After fix |
| --- | --- | --- |
| Cyclic CFB FAT chain and concurrent HTTP request | FAIL: synchronous inspection stalls until the separate process's 8-second watchdog kills it | PASS: refused within 5 seconds; concurrent health request completes within 500 ms; all inspection runs in a terminated, time/heap-limited worker |
| Retry after editing original PDF and converted text | FAIL: the original upload replaces the edited PDF | PASS: both edits survive a forced retry; acknowledgement reports `kept_existing` |
| New bridge connection after acknowledgement | FAIL: the receiver is called twice | PASS: one transfer and one persisted `file.delivered`; the member's changed bytes survive |
| Suspend/wake and saved disk | Missing edit-survival proof | PASS: lifecycle suspend/resume, disposable computer pause/unpause and replacement retain both edits; the following real Codex turn reads the edited text through the stub provider |
| Conflict report and replay | Missing conflict outcome | PASS: a differing existing file is kept on first delivery; the HTTP list reports `deliveryOutcome: kept_existing` after projection rebuild |

PASS: `npx vitest run apps/server/test/upload.test.ts`, all seven tests.
The red reproduction logs are `/tmp/upload-red-cyclic.log`,
`/tmp/upload-red-edits.log` and `/tmp/upload-red-reconnect.log`; the final focused
run is `/tmp/upload-green-blockers-final.log`.

PASS: root `lint`, `typecheck` and `check:events` (76 event types). Lint retains
five existing function-length warnings. PASS:
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --testTimeout=20000`
finished with 63 passing files and 1,030 passing tests; two live Kubernetes files
and the real-provider test were skipped (three tests, NOT RUN). The full run had
no timing failures requiring an isolated rerun. Safe gate logs:
`/tmp/upload-blockers-lint.log`, `/tmp/upload-blockers-typecheck.log`,
`/tmp/upload-fix-events.log` and `/tmp/upload-blockers-tests.log`.

Fresh-install Kubernetes qualification and hosted CI remain NOT RUN. No runtime
dependency was added.
