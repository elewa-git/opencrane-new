# Personal tool read repair

Journey on a fresh dev stack: FAIL (core journey).

Date: 16 November 2026. Tested source: `5253b05b6`.
Base: `29d0d2cb7`. The later evidence commit changes documents and pictures only.

## Fresh journey

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

The attempt ran from 13:14:39 to 13:23:30 UTC (8 minutes 51 seconds).
The trapped `infra/dev-stack/down.sh` completed successfully and removed the claimed
slot directory. No second journey was run.

- PARTIAL: [390 px completed chat and retained partial reply](workspace-390.png).
- FAIL: [1280 px session failure](desktop-session-failure.png).
- NOT RUN: the remaining desktop and later core assertions after that failure.

Both retained pictures were visually checked for private identifiers and secrets.
This receipt does not qualify live personal-key consent or a real model provider.
The failed core journey holds this draft from landing.

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
