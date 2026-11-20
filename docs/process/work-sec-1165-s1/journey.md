# Fresh CORE journey

Journey on a fresh dev stack: FAIL. Fresh CORE and the explicit journey passed;
the supplemental refusal probe exited 1 before it could report its assertions.

Source: `12443a0e2`. No product code changed during this qualification attempt.

## Third attempt

Both secondary slots reported free, no `package-*` stack was running, and every
30-second sample across the five-minute admission window had a 1-minute load below
6. Claimed secondary slot 1.

Ran `infra/dev-stack/up.sh --fresh` as requested. It exited 1 before starting a
stack because it defaulted to the owner stack while `OPENCRANE_FLEET_TASK` was set.
The sanitised startup diagnostic was: `Owner commands require --owner-run, interactive
stdin and no fleet task`. This failed invocation was not retried. No provider,
services or browser journey started.

Copied the sanitised startup log before teardown. No service logs or screenshots
were produced because stack preparation and CORE did not start. `down.sh --id 1`
exited 0; afterwards both secondary slots reported `free`, and no package stack was
running. [Attempt receipt](attempt-3/receipt.md) records the exact result.

## Outstanding live checks

- FAIL: fresh startup invocation, as recorded above.
- NOT RUN: CORE at 1280 × 900 and 390 × 844 px.
- NOT RUN: cookie-free and ticket-free POST and WebSocket refusals, direct HTTP
  upgrade, event-head checks and Origin audit counts against real conversations.
- NOT RUN: fresh screenshots and service logs from a completed CORE run.

The earlier journey and startup attempts belong to earlier source heads; they do not
qualify `12443a0e2`. PR #1172 remains a draft and cannot land with this qualification
outstanding.

CI required checks at `12443a0e2`: PASS when checked at 2026-11-20. See the PR checks.

## Fourth attempt — admission

Journey: FAIL before claim. CORE: NOT RUN. Supplemental live checks: NOT RUN.
Teardown: NOT RUN; this attempt claimed no slot and started no stack.

Source: `ca1c14048`. At the start of the five-minute admission window, both
secondary slots reported free, no `package-*` stack was running, and the
1-minute load was below 6. Samples every 30 seconds continued to report load
below 6 and both slots free. At 08:56:29 UTC, the combined status command stopped
reporting slot results. A bounded status check for slot 1 timed out after 25
seconds. Docker showed a different task starting a secondary stack and holding
the slot 1 lock. The slot was therefore no longer confirmed free, so this
journey did not claim a slot or start a stack.

The full five-minute window had elapsed, but admission failed because the
secondary-slot-free condition was no longer true. No startup logs, service logs,
or screenshots were produced by this attempt. No dev-stack teardown command was
run because this attempt owned no stack.

## Fifth attempt — fresh CORE and refusal checks

Journey on a fresh dev stack: FAIL. CORE: PASS. Explicit `journey.sh`: PASS.
Supplemental live refusal checks: NOT VERIFIED. Teardown: PASS; both secondary
slots are free.

Source: `dc8b2eda2facdc839388ac7bdd5bb10a14348649`. This run used a fresh claimed
secondary slot 1 and the stand-in provider. The built-in CORE journey ran at
1280 × 900 and 390 × 844 px. It passed sign-in, streamed chat, reload and Stop,
upload and preview refusals, desktop grant and revocation, private-history
refusals, spending limits, computer lifecycle, member and catalogue replay, and
sign-out and reauthentication. The approval sub-journey skipped because it
waits for issue rows 4, 5 and 14.

Both slots stayed free, no `package-*` stack was running, and 1-minute load
remained below 6 for the full admission window. Ten samples covered 318 seconds;
the [sample record](attempt-5-admission.jsonl) lists each observation. Slot 1
was claimed. `up.sh --fresh --id 1` exited 0. `status.sh --id 1` reported all
services healthy, and `journey.sh --id 1` exited 0 with the core browser and
replay checks passing.

The separate anonymous and Origin probe exited 1. Sign-in and its initial
authentication checks passed, but the browser helper failed during cleanup
when it tried to reauthenticate after sign-out. The sanitised diagnostic,
with the provider URL and private stack path omitted, was:
`Real browser logout failed at login for XHR: Login did not complete at provider
input (net::ERR_ABORTED; page errors: none; console errors: none).` The probe
printed its assertion summary only after that cleanup, so the required
cookie-free POST and WebSocket results, direct HTTP upgrade result, global-head
comparisons, and valid/invalid-session Origin audit counts are NOT VERIFIED.
This run does not qualify those checks.

Before teardown, 56 screenshots and 16 sanitised service logs were copied to the
task receipt, along with the sanitised startup, status, journey and probe logs.
`down.sh --id 1` completed. `status.sh --id 1` and `status.sh --id 2` both
reported `free`; no package stack remained. No product source changed.

Required PR checks at this source head were green: `checks`, `ci-ok`,
`fixtures-browser`, `fixtures-image`, `select`, and test shards 1–4. The
supplemental live checks remain the merge blocker.

## CI result for the receipt commit

Workflow `44717013684` on receipt head `028298306` finished with `test (3)` and
`ci-ok` failed. Shards 1, 2 and 4, `checks`, `fixtures-browser`, `fixtures-image`
and `select` passed.

Shard 3 ran 161 files: 160 passed and one failed. Of 3,994 tests, 3,988 passed,
four were skipped and two failed in `apps/server/test/routine-sender.test.ts`:

- `refuses saved modern budget exhaustion with reasons` timed out in its
  `beforeEach(setup)` hook after 30 seconds.
- `refuses saved modern budget exhaustion with work` failed in the projection
  fixture: `Routine computer unavailable`; the underlying assertion expected
  one projected record and received zero.

No product source changed in the receipt commit. Required CI is FAIL on that
head; this journey report does not claim green CI.
