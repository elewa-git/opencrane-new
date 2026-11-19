# Fresh CORE journey

Journey on a fresh dev stack: NOT RUN

Date: 19 November 2026. Local source and test head:
`4d032808c8bebcb6ff3e3e4e268c9ad46bc95197`.
There is no live tested head: no secondary slot was claimed or started.

## Reason

The required source gates did not all pass. The newly available local Cosign/Syft
suite still times out in `keeps a clean scan waiting after real Cosign and Syft checks`,
also when run alone with one worker. A temporary diagnostic run logged the expected
handler failure and passed; it does not establish the cause or qualify the original
suite. Its temporary logging changes were removed. No assertion, wait or product
access window was relaxed.

The builder stopped implementation just over seven hours into the eight-hour
allowance. Diagnosing and verifying an unproven fixture repair, then running fresh
CORE and preserving evidence and teardown, no longer had a safe margin. The draft
remains blocked for merge. This is NOT RUN rather than a live pass or a guard bypass.

## Availability and actions

[Availability samples](availability.txt) checked both secondary slots, package
stacks and load every 30 seconds. The conditions held for more than five minutes.
The monitor also required a source-gates marker, which was never created. It was
stopped after the unresolved gate and budget decision.

| Required action | Result |
| --- | --- |
| Claim a secondary slot | NOT RUN; source gates blocked. |
| Start `up.sh --fresh` and check status | NOT RUN. |
| Use the running product through Playwright at 1280 px and 390 px | NOT RUN. |
| Observe CORE actions and refusals | NOT RUN. |
| Copy journey screenshots before teardown | NOT RUN; no journey or screenshots exist. |
| Preserve startup/service failure logs | Not applicable; no startup was attempted. |
| Tear down the claimed secondary slot | Not applicable; no slot was claimed. |

[Own checks and failures](checks.md) retain the actual source evidence. The normal
CORE runner's separate legacy approval skip is also NOT RUN; it was not exercised
by this task.
