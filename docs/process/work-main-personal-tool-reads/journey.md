# Personal tool read repair

Journey on a fresh dev stack: PASS (core journey; rerun).

Date: 16 November 2026. Tested source: `5253b05b6`.
Base: `29d0d2cb7`. The later evidence commit changes documents and pictures only.

## First fresh journey

Claimed secondary slot 1 through `infra/dev-stack/claim.sh`. Waited until the
one-minute load was below 10 before claiming and starting. Referenced the existing
Zitadel key by file path and ran `nice -n 10 infra/dev-stack/up.sh --fresh` once.
Used the real sign-in and local services with the free model stand-in.
This worktree ran no test or lint batch alongside the journey. The owner stack was not used.

Expected: complete the core journey on a fresh installation, including chat at
390 px and 1280 px, then release the claimed stack.

Observed: the entrypoint returned 1. Bootstrap, provider setup and website readiness
passed; website readiness took 63,835 ms. The 390 px chat completed its stub reply
and kept partial text after Stop and reload. The next browser phase reached a
1280 px sign-in page saying “We could not check your session”. No 1280 px workspace
picture was produced. The underlying session failure remains unproved; the runner's
private error details were removed during cleanup and are not retained here.

The first attempt ran from 13:14:39 to 13:23:30 UTC (8 minutes 51 seconds).
The trapped `infra/dev-stack/down.sh` completed successfully and removed the claimed
slot directory.

- PARTIAL: [390 px completed chat and retained partial reply](workspace-390-first.png).
- FAIL: [1280 px session failure](desktop-session-failure.png).
- NOT RUN: the remaining desktop and later core assertions after that failure.

Both retained pictures were visually checked for private identifiers and secrets.
This attempt did not qualify live personal-key consent or a real model provider.

## Source checks

- PASS: the consent regression passed before the read changes. Breaking the
  preparation consent guard then made it fail; restoring the guard made it pass.
- PASS: 367 server/model tests across 14 files, twice, using the shared disposable
  PostgreSQL fixture and at most two workers. The main 275-test set took 301 and
  211 seconds; the additional 92-test set took 64 and 47 seconds.
- PASS: 20 consent-related web tests across three files, twice. Test execution
  took 9 and 7 seconds, after the Angular builds.
- PASS: `BASE_SHA=origin/main npm run lint:reads`: personal tool context has two
  whole-stream read sites, down from four, against an unchanged baseline of two.
  The stale decision baseline decreases from two to one. Total known reads: 311.
- PASS: typecheck, event catalogue check, changed-file ESLint without warnings,
  knip, Markdown lint, README size checks and changelog validation. All ran under `nice -n 10`.

The existing consent and personal-key tests were kept unchanged. The added test
pins legacy owner consent after assistant activity, refusals for foreign, shared
and missing assistants, and explicit consent for a shared assistant.

## Fresh rerun

Journey on a fresh dev stack: **PASS (core journey)**.

Date: 16 November 2026. Tested source: `6342bac90`.

The one-minute load was above 8 when monitoring began. Startup waited until the
14:21 UTC reading was 4.43, then claimed secondary slot 1 with `claim.sh` and ran
`up.sh --fresh` with the existing Zitadel credential referenced by path. No test
or lint batch ran alongside the journey. The owner stack was not used.

Expected: sign in and complete the core journey at 390 px and 1280 px on a fresh
installation, then release the claimed stack.

Observed: sign-in passed for the owner and member at 390 px and the member at
1280 px. The full core journey passed, including chat, upload and preview at both
widths, live view, audit, budget, replay and token-boundary checks. The launcher
reported `Stack ready`; the shell trap ran `down.sh` and released slot 1.

The earlier 1280 px message, “We could not check your session”, did not recur.
This run has no failing session request or server error to report, so it does not
establish the cause of the first failure. The PR changes personal tool context
reads and consent preparation in `libs/models`; the sign-in session check is in
the unchanged web sign-in code and does not call those functions. The PR change
therefore has no direct path to the session check. This is a code-path assessment,
not proof of the earlier failure's cause.

- PASS: [1280 px workspace screenshot](workspace-1280.png).
- PASS: [390 px workspace screenshot](workspace-390.png).
- PASS: core journey and slot cleanup.

The screenshots show synthetic journey prompts and were checked for credentials
and private user content. This run does not qualify live personal-key consent or
a real model provider.
