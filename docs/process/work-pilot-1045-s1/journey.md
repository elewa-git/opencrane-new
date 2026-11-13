# Workspace sign-out and Settings journey

Journey on a fresh dev stack: FAIL — 13 November 2026, source head
`314a574c624aaed5f991941b1239d285cd7d5c6f`. Startup diagnosis passed on both
`origin/main` and this PR head at low load. The latest fresh `up.sh --fresh`
failed during Zitadel setup, before the core or workspace runner. Every slice
acceptance step is NOT RUN on this run. The previous PASS does not qualify this
source.

## Integration

Rebased onto `origin/main` at `7ec65e982f543f93b5829db39486cc8ca8eecfaa`.
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
