# Rebased packaged journey attempt

Journey on a fresh dev stack: FAIL

Date: 23 November 2026. Product head: `59573055e269f54225a25b6cce0014bc203f4778`.

CI passed on this head. The application package approval (run `45087358119`)
and scanner package approval (run `45087361265`) passed, and both approval
artifacts were present and unexpired before preparation.

The first package preparation fetched the approved images and created an empty
package namespace. It was removed with `package-down --id 1` and
`down.sh --id 1` before the final admission window. Both secondary slots and
package namespaces were free for the recorded window; one-minute load stayed
below 6. The last sample qualified the window at 316 seconds at 00:56:59 UTC.
The coordinator started at 00:58:17 UTC, so the saved capacity result was
78 seconds old and failed its 60-second freshness limit with the exact error:
`The capacity check is stale`.

No package namespace or install was started in this attempt. The install
refusals, wrong-organisation sign-in, owner claim, wrong-token refusal, token
reuse (`HTTP 409 owner_exists`), owner chat, admin sign-in/chat/cookies, and
member sign-in/chat/cookies at 1280 and 390 px are **NOT RUN**. No screenshots
or startup/service logs exist because startup did not begin. The saved admission
samples and load records are in this folder.

Cleanup: `package-down --id 1` **PASS**; `down.sh --id 1` **PASS**. No retry was
made after the stale capacity refusal.
