# Workspace sign-out and Settings journey

Journey on a fresh dev stack: **PASS** — 15 November 2026, source head
`eb7730775c1ae66a6dd936f2d3d222a09f940b94`. Fresh startup and the full core
journey passed on secondary stack 2. The workspace sign-out and Settings journey
passed for members, admins and owners at 1280 px and 390 px. Screenshots and the
step-by-step receipt are in [slice-journey.txt](slice-journey.txt). The stack was
released with `down.sh` (exit 0).

## Final fresh slice journey

On 15 November 2026, the one-minute host load was 6.31 before the secondary
claim. `claim.sh` returned stack 2. `up.sh --fresh` passed owner bootstrap,
provider setup, website readiness, and the full core journey. Chromium completed
the core desktop and phone chat, upload, live-view, audit, and spending journeys.
The existing approval journey was skipped because it depends on issue 45 rows 4,
5 and 14; this is outside #1045 acceptance. The core run replay-verified members
and the MCP catalogue. The exact Zitadel credential path supplied for this run
was available. Setup used only the OpenCrane 2 Dev organisation.

`workspace-journey.ts` then passed every #1045 step at both widths. Members saw
no Settings link and received the Integrations refusal. Admins and owners opened
Settings. Member sign-out reached sign-in, while the separate owner browser stayed
signed in after each logout. The runner saved all ten screenshots under
[`screenshots/`](screenshots/). `down.sh` exited 0 and released the slot.

Final push checks on the same source:

- PASS: `nice -n 10 npx eslint apps/web/src/app/chat/workspace.spec.ts`.
- PASS: `npm run lint:debt`; the workspace spec remains within its frozen 2,999
  counted-line cap.
- PASS: changed web test, 118 tests.
- PASS: full `npm run typecheck` across workspaces, package and dev-stack code.
- PASS: `npm run check:events`, 174 event types.
- PASS: Knip; two existing configuration hints only.
- PASS: `npm run lint:changelog` and `npx markdownlint-cli2` (514 files).
- PASS: public privacy check and secret scan.
- NOT RUN: full root lint and full root test suite.

## Rebased head retest

Rebased onto `origin/main` at `5b4456b1b66f5f41d458d821c837a1b773512b6d`.
Rebased source head: `d1eb6a89e532e4cd9fa77e3da50c2466553f6382`.
The manual template conflict resolution kept the organisation name and account
details from main alongside this PR's role-gated Settings and shared Sign out.
All other commits applied without conflicts.

On 15 November 2026, the one-minute load was 5.63 before the secondary claim.
`claim.sh` claimed secondary stack 1. `nice -n 10 infra/dev-stack/up.sh --fresh`
failed at the Zitadel setup command:

```text
/usr/bin/node --experimental-strip-types infra/dev-stack/zitadel-setup.ts
Zitadel credentials unavailable (ENOENT); set ZITADEL_KEY_FILE to an existing private key file; no request sent
```

`ZITADEL_KEY_FILE` pointed to this worktree's `.keys/.zitadel-key`, which was not
readable. Private `failure.log` and `last-error.log` were copied outside the
repository before cleanup. `down.sh` exited 0. The core journey and workspace
runner were NOT RUN. This is a startup failure at Zitadel credential loading;
the updated Zitadel setup code on main started but could not load the configured
credential. No request was sent and no retry was made.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Member has no Settings link | NOT RUN | NOT RUN |
| Member types `/org/integrations` and sees refusal | NOT RUN | NOT RUN |
| Member uses Sign out and reaches sign-in | NOT RUN | NOT RUN |
| Admin sees Settings and opens it | NOT RUN | NOT RUN |
| Owner sees Settings and opens it | NOT RUN | NOT RUN |
| Separate owner browser remains signed in after member logout | NOT RUN | NOT RUN |

No screenshots were produced on this attempt. Existing screenshots remain
historical evidence only.

Changed tests on rebased head: **PASS**. The server chat HTTP test passed 1 test;
the three changed web specs passed 143 tests. No other tests were run.

## Rebased source checks

- PASS: full typecheck.
- PASS: `check:events`, 174 event types agree.
- PASS: changed-code ESLint, no errors. The dev-stack workspace runner was ignored
  by ESLint configuration and emitted one ignored-file warning.
- PASS: Knip, with two existing configuration hints.
- PASS: changelog lint and Markdownlint without file arguments, 514 files.
- PASS: public privacy check and secret scan.
- NOT RUN: full root test suite and full root lint.

## Integration

Rebased onto `origin/main` at `5b4456b1b66f5f41d458d821c837a1b773512b6d`.
Kept the core-journey repair, approval deadline comparison and verified personal-key
behaviour from main. Kept workspace Sign out, the caller's own role, owner-or-admin
Settings links, computer wording and removal of the empty Projects block.

Resolved compatible additions in the server reply, protocol schema and session by
keeping both `role` and `personalConnections`. Kept main's shared
`applyComputerMessage` helper because both branches extracted the same behaviour.
No conflicting product rule was found. No dependency, timeout or retry changed.
The lockfile did not change, so no dependency installation was needed.

## Fresh startup and cleanup

Both attempts used Linux, Node 22.23.3, Playwright Chromium and the stand-in model.
The feature needs no flag. Each attempt claimed secondary stack 2 through
`infra/dev-stack/claim.sh`, set the returned `DEV_STACK_ID` and the existing
`ZITADEL_KEY_FILE` path, and ran `nice -n 10 infra/dev-stack/up.sh --fresh`.
The inherited fleet marker stayed set. The owner stack was not used.
An EXIT trap always ran `infra/dev-stack/down.sh`.

| Attempt | Startup | Slice runner | Cleanup |
| --- | --- | --- | --- |
| First fresh installation | FAIL after 368 seconds | NOT RUN | PASS — exit 0; slot reported `free` |
| Second fresh installation | FAIL after 1,091 seconds | NOT RUN | PASS — exit 0; slot reported `free` |

The first attempt passed owner bootstrap, provider setup and website readiness,
then returned the generic startup failure. Teardown removed its private diagnostics,
so its exact failing assertion is unknown. The temporary launcher was corrected to
retain diagnostics privately before cleanup, and a second fresh installation ran.
This changed no repository code or product behaviour.

The second attempt passed the same startup checks and reached the core Spending
journey. `loadBudgetEditor` failed while waiting for the visible Budget scope control:

```text
Error: Spending budget editor did not load; inspect private evidence
    at loadBudgetEditor (infra/dev-stack/browser-budgets.ts:192)
    at save (infra/dev-stack/browser-budgets.ts:48)
    at browserBudgetJourney (infra/dev-stack/browser-budgets.ts:83)
    at infra/dev-stack/journey.ts:654
```

The retained command diagnostic proves that failure. It does not establish whether
the editor was refused, unavailable or failed to render. No cause is claimed beyond
the missing visible editor. The [public diagnostic](startup-diagnostic.txt) excludes
private paths and credentials. The core journey is FAIL; conditions before its final
result are not presented as a complete PASS. Core approval qualification remains
NOT RUN under its existing dependency on issue 45 rows 4, 5 and 14.

The workspace runner was not invoked after either failed startup. No product fix
or further retry was made. The failed core journey needs a separate decision before
fresh qualification can finish. Unrelated core pictures were restored to their
original tracked versions; newly generated category pictures were kept privately.
The worktree is retained and both claimed installations were released.

## Final fresh attempt on the rebased source

On 13 November 2026, the one-minute host load was 2.65 before claiming secondary
stack 2. `claim.sh` succeeded and `nice -n 10 infra/dev-stack/up.sh --fresh`
returned exit 1. The command printed only its generic failure message. The
launcher runs the shared core journey as part of `up`; the private error records
did not match the earlier Spending editor failure, and the failing stage is not
established. I copied `failure.log` and `last-error.log` to a private local
capture before `down.sh`. Cleanup returned exit 0 and the slot reported `free`.
The owner stack was not used. The workspace runner was NOT RUN because the fresh
start failed. No product code changed.

The Spending editor failure did not recur as an identified failure. The launcher
did not produce its budget-editor status record or screenshot, so there is no
budget-page browser console output, request-failure list or screenshot to copy.
This PR changes the chat context role and workspace navigation/sign-out; it does
not change the Spending editor, its requests or the budget journey. No direct path
from those changes to the failed Spending editor was identified. This does not
explain the generic failure from this final start.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Member has no Settings link | NOT RUN | NOT RUN |
| Member types `/org/integrations` and sees refusal | NOT RUN | NOT RUN |
| Member uses Sign out and reaches sign-in | NOT RUN | NOT RUN |
| Admin sees Settings and opens it | NOT RUN | NOT RUN |
| Owner sees Settings and opens it | NOT RUN | NOT RUN |
| Separate owner browser remains signed in after member logout | NOT RUN | NOT RUN |

## Slice steps on the rebased head: NOT RUN

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Member has no Settings link | NOT RUN | NOT RUN |
| Member types `/org/integrations` and sees refusal | NOT RUN | NOT RUN |
| Member uses Sign out and reaches sign-in | NOT RUN | NOT RUN |
| Admin sees Settings and opens it | NOT RUN | NOT RUN |
| Owner sees Settings and opens it | NOT RUN | NOT RUN |
| Separate owner browser remains signed in after member logout | NOT RUN | NOT RUN |

[Runner status](slice-journey.txt) records the startup block. No new slice screenshots
were taken. The ten existing pictures in `screenshots/` belong to the earlier
qualification at runner head `9b68c85f6cc03ba424f88b0100149cba2106ee26`, recorded
at evidence head `07c0d4ec6af9a573b3b6100b5f142ee115bcd62b`. They are historical
pictures, not evidence for this rebase. The earlier receipt remains in git history.

## Source checks

All lint, typecheck, build and test commands ran under `nice -n 10`.
Database tests used the shared disposable test database. No full root suite ran.
[Commands, files and initial failures](source-checks.txt) give the complete record.

| Check | Result |
| --- | --- |
| Focused web tests from both sides and the core repair | PASS — six files, 169 tests |
| Initial server/model run from both sides | PARTIAL — 674 passed, one failed across 12 files |
| Failed gateway test alone, unchanged | PASS — one passed, 22 skipped; those 22 passed in the initial run |
| Initial audit-browser test | FAIL — Angular was still building at its existing startup deadline |
| Development web build, then audit-browser alone | PASS — build and one test at its original limits |
| Opt-in hosted MCP checks | NOT RUN — 37 skipped; no opt-in was enabled |
| Personal-key stack fixtures | PASS — 111 Node tests |
| Core repair and journey-safety fixtures | PASS — 59 Node tests |
| Event field-security rules | PASS — 482 tests; rule and approved list unchanged |
| Full typecheck | PASS — workspaces, package and dev-stack code |
| Changed-code ESLint | PASS — no errors; one existing warning in untouched `registerChatRoutes` |
| Event catalogue | PASS — 174 types agree |
| Knip | PASS — existing configuration hints only |
| Changelog lint and Markdownlint without file arguments | PASS |

The gateway test's first allowed call received 403 before its refresh assertions.
It passed alone with unchanged code and limits. Concurrent load is a possible cause,
not a proved diagnosis. The complete initial failures remain explicit in the source
record. The audit fixture passed after the documented development build warmed
Angular's cache; no timeout or test assertion changed.

## Fresh slice attempt after startup diagnosis

The startup diagnosis in [diagnosis.md](diagnosis.md) recorded fresh startup and
the full core journey passing on both `origin/main` and this PR head at low load.
This fresh attempt used the PR head above. The one-minute host load was 9.31
before the secondary claim. `claim.sh` succeeded, then `nice -n 10
infra/dev-stack/up.sh --fresh` returned exit 1 during `zitadel-setup.ts` before
the core journey started. The launcher reported that setup failed without a
provider response. Its private `failure.log` and `last-error.log` were saved
before cleanup. `down.sh` returned exit 0. The workspace runner was NOT RUN;
all six workspace steps remain NOT RUN at both widths. No product code changed.

This attempt did not reach Spending. The earlier Budget scope failure did not
recur. The PR changes workspace role and navigation behaviour; it does not
change Zitadel setup or the Spending editor. The diagnosis confirms that the
PR's changed paths were present during a passing core journey, but it does not
prove why this startup failed.

Public privacy and secret scans are required again before the integration push.
CI results are recorded in the PR Evidence after that push.

## Final fresh slice attempt

On 13 November 2026, the one-minute host load was 1.22 before claiming secondary
stack 1. `claim.sh` succeeded. `nice -n 10 infra/dev-stack/up.sh --fresh` returned
exit 1. The exact failing setup command was `/usr/bin/node
--experimental-strip-types infra/dev-stack/zitadel-setup.ts`, launched under its
Zitadel lock. Setup reported failure and no provider response was logged. Private `failure.log` and
`last-error.log` were retained before cleanup. `down.sh` returned exit 0 and the
slot was released. The core journey and workspace runner were NOT RUN. No product
code changed.

This run stopped before Spending, so it produced no budget-editor browser console,
network-failure list or screenshot. The earlier Spending failure did not recur.
The PR changes workspace role and navigation behaviour; they do not change
Zitadel setup or the Spending editor. No direct path from these changes to either
failure was identified. The startup diagnosis still shows the PR's changed paths
present during passing fresh core journeys on main and the PR head.

| Step | 1280 px | 390 px |
| --- | --- | --- |
| Member has no Settings link | NOT RUN | NOT RUN |
| Member types `/org/integrations` and sees refusal | NOT RUN | NOT RUN |
| Member uses Sign out and reaches sign-in | NOT RUN | NOT RUN |
| Admin sees Settings and opens it | NOT RUN | NOT RUN |
| Owner sees Settings and opens it | NOT RUN | NOT RUN |
| Separate owner browser remains signed in after member logout | NOT RUN | NOT RUN |
