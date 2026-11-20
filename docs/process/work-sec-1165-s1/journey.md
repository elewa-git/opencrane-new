# Fresh CORE journey

Journey on a fresh dev stack: FAIL at startup. CORE: NOT RUN. Supplemental live checks: NOT RUN.

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
