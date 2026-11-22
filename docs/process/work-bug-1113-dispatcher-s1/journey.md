# Dispatcher database connection

Journey on a fresh dev stack: PASS

Date: 22 November 2026. Rebased on `origin/main` at `5740ea84e`.
The product changes are in `576cc9b89` and `cb2816eaa`.

## Fresh CORE results

The fresh CORE journey passed at 390 px and 1280 px. At each width, the viewer
refused access before a desktop grant, displayed the real desktop after the grant,
and stayed open while the stub reply completed. Revoking the grant cleared the
pixels and recorded the stop audit. The viewer closed in 345 ms at 390 px and
108 ms at 1280 px on the fresh start.

The requested explicit `journey.sh --id 1` run also exited successfully. It
repeated the same viewer checks at both widths; the viewer closed in 184 ms at
390 px and 243 ms at 1280 px. Both runs completed the chat reply while the viewer
was open.

The approval journey printed **SKIP** because rows 4, 5 and 14 of its separate
ticket are not ready. That condition is **NOT RUN** and is not counted as a pass.
It is outside this dispatcher slice's CORE acceptance checks.

## Stack and browser steps

1. Waited until both secondary slots were free, no package stack was up, and the
   one-minute load stayed under 6 for more than five minutes.
2. Claimed slot 1 with `infra/dev-stack/claim.sh`. Ran
   `infra/dev-stack/up.sh --fresh --id 1`; website readiness passed in 41,012 ms.
   Startup ran CORE automatically. No paid provider was used.
3. Ran `infra/dev-stack/status.sh --id 1`; every service was running and healthy.
   Then ran `infra/dev-stack/journey.sh --id 1`; it exited 0 and repeated the CORE
   checks.
4. After both journeys, `status.sh --id 1` still reported the dispatcher running.
   The retained dispatcher log had no pool-timeout matches. No dispatcher restart
   occurred during either journey.
5. Copied startup output, journey output, service logs and screenshots to the
   private task receipt before `infra/dev-stack/down.sh --id 1`. The down command
   exited 0 and `status.sh --id 1` then reported `free`.

## Artefacts

- [390 px viewer after access was granted](screenshots/viewer-390-pass.png)
- [1280 px viewer after access was granted](screenshots/viewer-1280-pass.png)
- [390 px viewer entry](screenshots/viewer-entry-390-pass.png)
- [1280 px viewer entry](screenshots/viewer-entry-1280-pass.png)
- [Safe live-view check summary](logs/live-view-checks.json)
- The full startup output, explicit journey output, service logs and all stack
  screenshots are in the private task receipt. They were copied before teardown.

## Earlier run before the main fix

The earlier attempt failed at the 390 px viewer step: the viewer opened, but the
next reply did not reach **Done** within the existing 30-second wait. The computer
worker processed `agent.turn_failed`; its cause was not proved. The 1280 px steps
were **NOT RUN** after that failure. Those artefacts remain in the first-run
receipt and in the earlier commit history. This fresh run was performed after
the live-viewer reply fix had reached `origin/main`.

The public images were checked. They contain fixture content and no credentials
or email addresses. Private paths and sign-in identifiers are kept out of this
receipt.

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

The rebased PR CI run passed. Packaged journeys for the sign-in and provider
tickets and paid-provider behaviour are **NOT RUN** in this bug-fix PR. The
approval journey is also **NOT RUN**, as recorded above. Independent review is
left to the orchestrator.

After the receipt update, local typecheck, check:events, Knip, changelog lint,
markdownlint, public privacy and secret scans all passed.
