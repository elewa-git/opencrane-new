# P3-17 secondary-stack qualification

4 October 2026. Review pass 2: LAND at `93c80ee`, confirmed by the owner.
Rebase: PASS onto `origin/main` at `39fe9da`; reviewed changes now end at
`9f8b5bf`. The rebase completed, with both MCP discovery and requester-control
README sections retained, and main's gateway JWT-log waiting helper retained.
During qualification, `origin/main` advanced to `7b8b1d3` (attachments #79).
That later runtime integration is NOT RUN: it changes computer source and needs
a further rebase, matching rebuilt image and fresh qualification before landing.
This receipt and its source checks apply to the `39fe9da` snapshot.

| Check | Result | Evidence |
| --- | --- | --- |
| Reviewed computer image and licence gate | PASS | [Image receipt](p3-17-live/image.json); 384/384 packages accepted |
| Lint | PASS | Nine existing size warnings; zero errors; dependency, unused-code, docs, links and fixture checks passed |
| Typecheck | PASS | All workspaces; separate dev-stack typecheck also passed |
| Event catalogue | PASS | All 85 registered event types match the catalogue |
| Root tests | PASS | 75 files / 1,374 tests; four opt-in files / 16 tests skipped |
| Web production build | PASS | Existing size/CommonJS warnings |
| Web tests | PASS | 11 files / 56 tests |
| Secondary `up.sh --fresh` | FAIL | Authority checks closed the viewers/control with `access_changed` |
| Secondary plain `up.sh` | FAIL | Existing viewer failed before takeover; its single rerun also failed |
| Full takeover browser journey | PARTIAL | Both threads paused; keyboard and pointer reached X in attempt 4; full Release/expiry/participant journey has not passed |
| Teardown | PASS | Both claimed stacks removed with `down.sh --id`; stack 2 namespaces, Compose containers and private directory absent |

The source-only image was reused, published to the local registry and pinned in
`sandbox-template.json` at
`sha256:7e0d39c39547b0f5e1ad0c5662dc14773b8da6ed37f79942c57f950a12f0f4fa`.
Its computer and routing files match the rebased source byte for byte, with the
same file list. Contents and notice gates passed: root-owned execution paths,
no runtime credentials or build tools, and 91 installed notice filenames.
The licence gate accepted 339 Debian main packages, 38 OSI applications and
seven OSI applications with reviewed free bundled notices. The tracked
inventory adds only our existing `@opencrane/models` routing package
(AGPL-3.0-or-later); all 383 previous decisions are unchanged. The actual
secondary Pods used this digest under gVisor, Ready with zero restarts.

The secondary slots were claimed with the requested `claim.sh` loop. Every
stack command selected its claimed id and used the supplied Zitadel key file.
Only secondary stacks 1 and 2 were used. No owner stack was touched. Model
traffic used the stack's local provider fixture; no paid model calls were made.

Root test command:
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test -- --maxWorkers=2 --no-file-parallelism --testTimeout=30000`.
Elapsed: 2,141 seconds. Test files ran sequentially under the requested worker
cap; request-race tests still exercised concurrent calls. No source checks or
secondary stack ran alongside this final suite. Earlier concurrent runs failed
(one delayed-writer timeout, then an interrupted run after nine viewer failures)
and are not counted as PASS. The first failing viewer case passed alone.

The takeover server now reuses the existing confirmed-history cache for its
computer and conversation reads. A regression first failed on reads starting
at sequence 1; warm reads now confirm the saved checkpoint and read its live
tail. A newly posted requester immediately invalidates the old control lease.
This small server fix postdates the review-approved base and needs an owner
landing decision under the two-pass review limit; no third review was run.
The slow-authority test's injected event-store delay changed from 400ms to
250ms, alongside its existing 650ms OpenFGA delay: the test still exercises
overlapping checks and leaves room for actual NATS/HTTP work. Production
1,200ms check deadlines, two-second revocation bounds and expiry are unchanged.

Live attempts, all recorded as FAIL:

1. Stack 1 fresh, concurrent with source checks: existing 390px viewer journey
   passed; new requester viewer closed before takeover.
   [Screenshot](p3-17-live/fresh-attempt-1-failure-390.png).
2. Stack 1 fresh rerun: existing viewer journey passed; both turns closed and
   takeover started, then writer `access_changed`. No Pod restarted.
   [Screenshot](p3-17-live/fresh-attempt-2-failure-390.png).
   Stack 1 was then torn down before final source tests.
3. Stack 2 fresh after the cache fix: the existing viewer step failed at
   `browser-live-view.ts:53`, before takeover.
   [Screenshot](p3-17-live/fresh-attempt-3-failure-390.png).
4. The requested single rerun of that existing live-view flake (#77) passed
   its viewer steps. Takeover paused both threads, and requester key `a` and
   pointer movement reached X. The participant viewer had already closed with
   `access_changed`, so the input-refusal step failed.
   [Screenshot](p3-17-live/fresh-attempt-4-failure-390.png).
5. A revised fixture admitted the participant after the threads were paused.
   Fresh qualification still failed: requester control closed before its
   keyboard step. [Screenshot](p3-17-live/fresh-attempt-5-failure-390.png),
   [takeover audit](p3-17-live/fresh-partial-390.json).
   Explicit Release through a real requester browser session succeeded before
   the plain run. [1280px paused screenshot](p3-17-live/fresh-failure-paused-1280.png).
6. Stack 2 plain `up.sh`: existing viewer closed before the zoom step at
   `browser-live-view.ts:61`, before takeover.
   [Screenshot](p3-17-live/plain-attempt-1-failure-390.png).
7. The requested single plain rerun also failed at the same zoom step before takeover.
   [Screenshot](p3-17-live/plain-attempt-2-failure-390.png).

Fresh-install takeover is not qualified. F8, the full two-conversation resume,
participant input refusal and real two-minute expiry are NOT RUN to completion
live. Both secondary slots were torn down; the last command was
`infra/dev-stack/down.sh --id 2`, which exited zero. The added secondary browser
journey contains these checks at 390px and
1280px and keeps the agent paused after expiry; it has not produced a full PASS.
