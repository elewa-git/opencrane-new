# Packaged journey attempt

Journey on a fresh dev stack: **FAIL**

Date: 23 November 2026. Approved product head: `59573055e269f54225a25b6cce0014bc203f4778`.
Receipt tip: `8926814b0`. CI passed on the receipt tip. The approved product head's
application and scanner package workflows passed, and both approval artifacts were
present and unexpired immediately before package preparation.

## Outcomes

| Step | Result | Evidence |
| --- | --- | --- |
| Five-minute quiet window | PASS | Both secondary slots and package namespaces stayed free; one-minute load remained below 6. |
| Final load sample | PASS | 0.65 immediately before package preparation. |
| `package-prepare --id 1` | PASS | Created the approved package namespace and private values file. |
| Package secret preparation | FAIL | Exact output: `Package secret preparation failed during preflight`. No slot `failure.log` existed. |
| Package installation | NOT RUN | `package-up` was not started. |
| Install refusals and browser journey | NOT RUN | No install existed to exercise. |
| Dispatcher restart | NOT RUN | The packaged dispatcher never started. |
| `package-down --id 1` | PASS | The prepared package namespace was removed. |
| `down.sh --id 1` | PASS | Slot 1 was released; both secondary slots report free. |

Wrong-organisation sign-in, owner claim, wrong-token refusal, token reuse
(`HTTP 409 owner_exists`), owner chat, admin sign-in/chat/cookies, and member
sign-in/chat/cookies at 1280 and 390 px are **NOT RUN**. There are no screenshots
or startup/service logs because installation did not begin. The exact failed
command output is retained in the task receipt outside the repository. No retry
was made.

The previous stale-capacity receipt links have been repaired. Local
`lint:links` and full `markdownlint-cli2` passed before this attempt.
