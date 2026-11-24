# Event worker recovery

Journey on a fresh dev stack: PASS

The CORE journey tested product commit `cde4985ab` on 23–24 November 2026.

1. Confirmed both secondary slots were free, no package stack was running and
   the one-minute load stayed below 6 for five minutes. Claimed slot 1.
2. Ran `infra/dev-stack/up.sh --fresh --id 1`. CORE passed at 390 px and 1280 px
   using the stand-in model. Ran `infra/dev-stack/status.sh --id 1` and confirmed
   that the services were healthy.
3. At both widths, signed in, sent a chat message and found the saved reply
   after reload. Before granting desktop access, the computer view showed
   `Unavailable` and exposed no desktop pixels.
4. Granted access and completed a reply with the live desktop open. Revoked
   access and saw `Access changed` with the desktop cleared. The fresh run
   cleared the desktop in 284 ms at 390 px and 173 ms at 1280 px.
5. Completed the upload, computer wake and replacement, sign-out, token
   exposure and projection replay checks.
6. Ran `infra/dev-stack/journey.sh --id 1`. Its browser and replay checks
   reported PASS at both widths. The repeat cleared the desktop in 364 ms at
   390 px and 284 ms at 1280 px. The repeat procedure was **PARTIAL** because
   the command wrapper received SIGTERM after the final CORE check. Its exit
   code was not captured and the live status check after it was **NOT RUN**.
7. Saved the screenshots and sanitised startup and service logs. Ran
   `infra/dev-stack/down.sh --id 1` and confirmed that slot 1 was free.

The optional approvals journey was **NOT RUN**.

## Browser screenshots

| Viewport | Desktop visible | Desktop after revocation |
| --- | --- | --- |
| 1280 px | [Viewing](screenshots/viewing-1280.png) | [Access changed](screenshots/revoked-1280.png) |
| 390 px | [Viewing](screenshots/viewing-390.png) | [Access changed](screenshots/revoked-390.png) |

## Injected JetStream failures

The test-only commit `410519988` reproduced failures after a socket drop,
an uncertain acknowledgement and a non-empty watcher read timeout. It also
reproduced a missing signal diagnostic in the worker fixture.

Real NATS socket drops proved that the same worker could resume an interrupted
delivery. Five interrupted pulls exhausted the budget, removed readiness and
exited with code 1. The SQL checkpoint and acknowledgement floor stayed at zero
in the exhaustion case.

Two tests withheld acknowledgement traffic after SQL committed. They covered both
a broker that had accepted the acknowledgement and a broker that needed to
redeliver. In both cases the same worker handled the waiting publication and
advanced to position 8. The publications left one receipt each and their
effects at positions 4 and 8.

Controlled time interrupted the watcher after it applied position 1. It resumed
at position 2 and applied both positions once. An observed sequence gap failed
immediately. Controlled time also verified waits of 100, 200, 400 and 800 ms,
cancellation during a wait and immediate rejection of a permanent error.

The checkpoint refusal tests covered changed silo, manifest, missing row and
sequence gap after readiness. Each test failed when its guard was broken, and
the guards were restored before the two final runs.

## Local gates

- **PASS**. Two targeted runs with 143 passed tests each. The 11 opt-in k3d
  tests were **NOT RUN**.
- **PASS**. Workspace, package and dev-stack typecheck, event catalogue, Knip,
  changelog lint, Markdown lint, dependency checks and whole-stream read audit.
- **PASS**. ESLint on changed files covered by the repository configuration.
  The two infrastructure files are covered by dev-stack typecheck.
