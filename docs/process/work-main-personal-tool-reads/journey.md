# Personal tool read repair

Journey on a fresh dev stack: PASS (core and PERSONAL-KEY CONSENT journeys).

Initial attempt: 16 November 2026. Tested source: `5253b05b6`.
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

## Personal-key consent journey

Journey on a fresh dev stack: **PASS (PERSONAL-KEY CONSENT)**.

Date: 16 November 2026. Tested source: `7fb923bf7`.
This evidence update changes documents and screenshots only. Part of #576.

### Fresh installation and load

Checked the host load before starting; the one-minute reading was 3.66.
Claimed secondary slot 1 through `infra/dev-stack/claim.sh`, exported
`DEV_STACK_ID` and referenced the existing Zitadel credential through
`ZITADEL_KEY_FILE`. Ran `nice -n 10 infra/dev-stack/up.sh --fresh` and
`infra/dev-stack/status.sh`. Fresh startup and its full core journey passed.
The owner stack was not used. No test or lint batch ran in this worktree during
live qualification.

Reused the [personal-key consent journey](../work-pilot-1105-s1/journey.md)
and its [selection collector](../work-pilot-1105-s1/collect-choices.mjs).
The guarded Stage B local TLS transport ran `apps/demo-mcp` in its
credential-checked mode with two private, generated synthetic keys and the free
model stand-in. It used real sign-in, server, models, native computer,
PostgreSQL, NATS and OpenFGA services. No external supplier or model provider
account was contacted.

Host load rose during core startup. Waited while the one-minute load exceeded
8 before the admin browser phase, member phases, consent changes, turn starts
and saved-event readback. The largest saved pre-action reading was 7.69.
The member browser journey ran from 15:48:31 to 15:53:05 UTC.

### Steps and results

The admin installed the demo through the browser. Discovery completed through
four normal status reads. Allowed `read_fixture_quote` and `who_am_i`, kept
`change_delivery_slot` blocked, chose “Needs a personal key” and selected
`who_am_i` as the identity tool. Granted member A and their personal assistant,
then published the reviewed definitions. Both grants returned HTTP 200 with
`appended`; publication was confirmed through four normal status reads.
The unchanged catalogue check and initial audience were saved before publication.

Installed once; captured the admin review and publication at both widths.
Repeated the member journey at 1280 × 900 and 390 × 844. Used keyboard Space
for desktop consent changes and clicks for phone changes. Each change made
one selection append, returned HTTP 200 and confirmed the resulting checkbox.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Admin installs, reviews personal-key mode, grants and publishes | PASS | PASS |
| A saves, verifies and selects their synthetic key | PASS | PASS |
| Own assistant starts checked; shared assistant starts unchecked | PASS | PASS |
| Own assistant completes a live quote read as account-a | PASS | PASS |
| A switches their own assistant off in My tools | PASS | PASS |
| Next turn completes with plain refusal and a working My tools link | PASS | PASS |
| Refusal contains neither account identifier nor key | PASS | PASS |
| Saved events show no credential release or tool dispatch while off | PASS | PASS |
| A follows the link and switches their own assistant back on | PASS | PASS |
| Own assistant completes another live read as account-a | PASS | PASS |

Both successful replies returned the synthetic quote for 12500 euro cents and
zero recorded effects. The refusal said “Your key is not allowed for this
assistant” and linked to “Change this in My tools”. Following that link opened
My tools and allowed the saved choice to be restored.

### Saved releases and dispatches

The [saved-event readback](consent/release-readback.json) retains all four
matching `credential.released` records, all four matching
`tool.dispatch_started` records, six selection records, conversation references,
profile-list statuses and pre-action load readings. The
[browser observations](consent/observations.json) retain the before, refused
and restored conversation references.

| Width | Before: releases / dispatches | While off | Refused conversation | Restored |
| --- | --- | --- | --- | --- |
| 1280 px | 1 / 1 | 0 / 0 | 0 / 0 | 1 / 1 |
| 390 px | 1 / 1 | 0 / 0 | 0 / 0 | 1 / 1 |

The off intervals are saved positions 514–533 and 605–624 respectively.
The collector checks the entire interval between each off and on selection,
as well as the refused conversation. Neither contains a credential release or
upstream tool dispatch. Each restored release names the newly enabled selection
revision exactly: 533 at desktop width and 624 at phone width. Every release
has a 30000 ms lifetime. All 10 observed profile-list responses were HTTP 200.

| Selection | Expected position | Saved position | Allowed assistants |
| --- | --- | --- | --- |
| Desktop key selected | 0 | 471 | Own assistant by default |
| Desktop assistant off | 471 | 514 | None |
| Desktop assistant on | 514 | 533 | Own assistant |
| Phone key selected | 533 | 561 | Own assistant |
| Phone assistant off | 561 | 605 | None |
| Phone assistant on | 605 | 624 | Own assistant |

### Screenshots and cleanup

Viewed all 16 screenshots before publication. Credential inputs were empty at
capture and email text was masked. Both widths fitted without horizontal
document overflow; phone My tools scrolls vertically through the two profiles.

| State | 1280 px | 390 px |
| --- | --- | --- |
| Admin personal-key review | [Review](consent/review-1280.png) | [Review](consent/review-390.png) |
| Publication confirmed | [Published](consent/published-1280.png) | [Published](consent/published-390.png) |
| Default assistant choices | [Defaults](consent/my-tools-default-1280.png) | [Defaults](consent/my-tools-default-390.png) |
| Live tool before disabling | [Tool](consent/tool-before-1280.png) | [Tool](consent/tool-before-390.png) |
| Own assistant off | [Off](consent/my-tools-off-1280.png) | [Off](consent/my-tools-off-390.png) |
| Completed refusal and link | [Refusal](consent/chat-refusal-1280.png) | [Refusal](consent/chat-refusal-390.png) |
| Own assistant restored | [On](consent/my-tools-on-1280.png) | [On](consent/my-tools-on-390.png) |
| Live tool restored | [Tool](consent/tool-restored-1280.png) | [Tool](consent/tool-restored-390.png) |

PASS: the cleanup trap ran `infra/dev-stack/down.sh`, status 0, at 15:53:57 UTC.
A subsequent `infra/dev-stack/status.sh` reported `free`. The private process
logs were retained outside the repository. Pre-existing worktree changes were
preserved byte-for-byte. External supplier and real model provider qualification
remain NOT RUN; they are outside this journey.

### Evidence update checks

PASS: workspace, package and dev-stack typecheck; event catalogue check
(174 event types); knip; Markdown lint; process-evidence and qualification-index
checks; changelog check; public-privacy check; and secret scan. Typecheck and
lint ran under `nice -n 10`, after live qualification and stack teardown.
Knip reported its two existing configuration hints.

NOT RUN: additional unit tests and changed-file ESLint, because this update
changes no code. The earlier source checks above remain the source evidence.
No full root test suite was run.
