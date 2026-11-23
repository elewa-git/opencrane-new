# Event worker recovery

Journey on a fresh dev stack: PASS

23 November 2026. The fresh CORE journey tested product commit `625801194`.

1. Waited for both secondary slots to be free, with no package stack running
   and the one-minute load below 6 for five minutes. Claimed slot 1.
2. Ran `infra/dev-stack/up.sh --fresh --id 1`. The built-in CORE journey
   passed against this slot's local origin with Playwright and the stand-in model.
   Ran `infra/dev-stack/status.sh --id 1` and confirmed every service was healthy.
3. Signed in at 390 px and 1280 px, sent a chat message, and verified the saved
   reply after reloading. Opened the computer view before granting desktop access
   and saw `Unavailable` with no desktop pixels at either width.
4. Granted access, opened the live desktop and completed a reply with it still
   open. Revoked the grant and saw `Access changed` with the desktop cleared.
   The fresh run cleared the desktop in 252 ms at 390 px and 407 ms at 1280 px.
5. Completed CORE's upload, computer wake and replacement, sign-out, token
   exposure and projection replay checks.
6. Ran `infra/dev-stack/journey.sh --id 1` and repeated CORE successfully.
   The repeat cleared the desktop in 358 ms at 390 px and 217 ms at 1280 px.
   Status reported the same dispatcher process before and after the repeat.
7. Copied screenshots and saved sanitised startup and service logs before
   teardown. Ran `infra/dev-stack/down.sh --id 1` and confirmed the slot was free.

The optional approvals journey was **NOT RUN** because its separate prerequisites
are pending.

## Browser screenshots

| Viewport | Desktop visible | Desktop after revocation |
| --- | --- | --- |
| 1280 px | [Viewing](screenshots/viewing-1280.png) | [Access changed](screenshots/revoked-1280.png) |
| 390 px | [Viewing](screenshots/viewing-390.png) | [Access changed](screenshots/revoked-390.png) |

## Injected JetStream failure

The test-only commit `a2eacf86b` reproduced worker exits on missed pull
heartbeats and a computer watcher stream-info timeout. The passing tests paused
replies from real NATS on one worker connection at a time. The pull test observed
delivery of event 7 with the SQL checkpoint and durable acknowledgement at 6.
After recovery and redelivery, both positions reached 8. Two publications left
two effects at positions 4 and 8 and one saved receipt for each publication.
The same worker process stayed ready.

The watcher resumed after its read timed out. The persistent silence test used
all four retries, then exited with code 1 and withdrew readiness. Stopping the
NATS process also caused a failed exit. The fault injection ran in the focused
tests. The browser journey exercised normal operation on the fresh stack.

## Local gates

- **PASS**. Two targeted runs, each with 133 passed tests and 11 opt-in k3d
  cases **NOT RUN**. An additional 85 stack launcher and guard tests passed.
- **PASS**. Workspace, package and dev-stack typecheck, event catalogue, knip,
  changelog lint, Markdown lint, dependency checks and whole-stream read audit.
- **PASS**. ESLint on changed files covered by the repository configuration.
  The two infrastructure files are covered by dev-stack typecheck.
