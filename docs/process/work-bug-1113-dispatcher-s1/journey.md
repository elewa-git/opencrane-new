# Dispatcher database connection

Journey on a fresh dev stack: FAIL

Date: 22 November 2026. Product source:
`5a06018ef278dc78632b50d600196411de363a1d`, based on `origin/main` at
`d6c4299aa822ae4078cf2b3b4b29d7d6f4aa1b3f`.

## Expected and observed results

The expected result was a complete CORE browser journey at 390 and 1280 px on a
fresh secondary stack, with the dispatcher continuing to process events.

The fresh CORE journey failed during the 390 px computer-viewer step. The viewer
displayed the real desktop, but the next agent reply did not reach **Done** within
the existing 30-second wait. The computer worker processed `agent.turn_failed`.
The cause of that turn failure is unproved. No timeout or retry was changed.

The dispatcher process identity and start fingerprint sampled during CORE were
unchanged immediately before teardown, and the process was alive. The retained
dispatcher log has no connection-pool timeout. This observation does not turn the
failed CORE journey into a pass. The regression test separately forces the pool
to have no spare connection and proves that the job and checkpoint still commit.

## Stack and browser steps

1. Waited for both secondary slots to report free, no package stack to remain,
   and the one-minute load to stay below 6 for more than five minutes. Another
   task briefly occupied slot 2; waited until it released the slot.
2. Claimed slot 1 through `infra/dev-stack/claim.sh`, then ran
   `infra/dev-stack/up.sh --fresh --id 1` under `nice -n 10`. Used the shared
   sign-in credential by path and the stand-in model. No paid provider was used.
   Website readiness passed in 47,769 ms. Startup automatically ran CORE.
3. The repository's Playwright runner used the slot's origin,
   `http://127.0.0.1:25106`, with separate real sign-in sessions. At 390 px, a
   complete chat reply appeared. Stop kept a partial reply after reload. A PDF
   upload reached Ready, and the upload and preview steps completed before the
   computer-viewer step began.
4. The viewer initially refused access without a desktop grant. After the grant,
   the viewer displayed the real desktop and its controls were exercised. The
   next chat turn failed while the viewer was open. CORE stopped at its existing
   reply-completion assertion: **FAIL**.
5. The 1280 px chat and remaining CORE steps were **NOT RUN** after that failure.
   The separate `status.sh` and repeat `journey.sh` commands planned after startup
   were **NOT RUN** because `up.sh` returned a failure.
6. Copied sanitised startup and service logs and all slot screenshots into the
   task's private fleet receipt before running `down.sh --id 1`. The runner exited
   with status 143 during the first teardown attempt, after services stopped. Ran
   `down.sh --id 1` again successfully; `status.sh --id 1` then reported `free`.
   Copied the selected public artefacts below and restored the shared viewer
   screenshot that CORE had overwritten outside this receipt folder.

## Artefacts

- [390 px chat and retained partial reply](screenshots/chat-390.png)
- [390 px PDF ready](screenshots/upload-ready-390.png)
- [390 px real desktop viewer](screenshots/viewer-390.png)
- [390 px failure capture](screenshots/live-view-failure-390.png)
- [Startup output](logs/startup.txt) and [failed assertion](logs/failure.txt)
- [Turn failure processed by the computer worker](logs/turn-failure.json)
- [Dispatcher process comparison](logs/dispatcher-process.json) and
  [retained service-log summary](logs/service-summary.json)
- [Released slot](logs/final-status.txt)

The public images were visually checked. They contain fixture content, with no
credentials or email addresses. Private paths and sign-in identifiers were
removed from the public text. The private fleet receipt retains the other
screenshots and sanitised service logs copied before teardown.

## Source checks

[Check output](checks.txt) records the expected failure before the fix and the
passing tests afterwards. All checks and tests ran under `nice -n 10`.

- **PASS:** the test-only commit `8471ec28f` failed with
  `timeout exceeded when trying to connect` in the dispatcher transaction.
- **PASS:** focused tests twice, 20 tests in three files per run, including
  dispatcher readiness and dispatcher/worker crash recovery. The second run
  includes the fixture cleanup.
- **PASS:** full handlers package, 78 tests in eight files; no skipped tests.
- **PASS:** full workspace and infrastructure typecheck, event-catalogue check,
  knip, changelog lint, changed-code ESLint with zero warnings, and markdownlint.
- **PASS:** additional README, whole-stream-read and size-debt checks.

Shared the existing lock connection with dispatcher preparation and transactions.
Kept pg-boss queue-setting reads on the existing enqueue transaction through one
runtime-local context. Reused the transaction adapter and fixture helpers. Named
the changed crash fixture's query callbacks and removed its nested ternary. Added
no dependency or size exception. Shipped code: 33 added and 12 deleted lines,
45 total, in the two handlers source files.

Packaged journeys for the sign-in and provider tickets, paid-provider behaviour,
and the skipped approval journey are **NOT RUN** in this bug-fix PR. Fresh CORE
remains **FAIL** and must pass before merge. CI is not awaited, following the
task's final PR instruction. Independent review is left to the orchestrator.
