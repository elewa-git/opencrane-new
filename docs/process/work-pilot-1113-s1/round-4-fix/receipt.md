# Preparation diagnosis and fresh qualification

Journey on a fresh dev stack: PASS for the packaged pilot journey. Production
F1/F2 host qualification remains PARTIAL under the accepted local exception.

## Cause and correction

23 November 2026. The previous command set `PACKAGE_VALUES_FILE` and also supplied
the filename as a positional argument. Preparation refuses that combination before
starting preflight. Its initial stage name incorrectly reported the refusal as
“during preflight”. The original invocation reproduces that message.

Direct preflight on approved product `59573055e` passed with the generated private
values file. It ran from the values directory and received only the filename and
the worktree's absolute reviewed-images filename, as preparation does. Both image
approval runs had unexpired artifacts. The values path and reviewed pins passed.
No credential, token or private filename is included in this receipt.

Test-first `7f7caa44a` reproduces the misleading diagnostic in three executable
cases: duplicate inputs, missing input and extra input. See the
[red result](values-arguments-red.txt). Fix `2a5176965` reports the safe code
`invalid_values_arguments` for that argument check. The argument guard, preflight
checks and rejection behaviour are unchanged. Supply the environment setting with
no positional arguments, or supply one positional filename without the setting.

The separate host probe refuses F1 and F2 on this box. The packaged journey uses
the documented per-command `OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366`
exception. Its command log and installation record must retain that decision.
Production F1/F2 qualification is PARTIAL. No host setting or memory check changed.

The diagnostic package and claimed slot were removed successfully before further
qualification. The owner stack was not used. Raw command output stays in the
private task receipt outside the repository.

## Source checks

PASS: changed package scope twice, 104/104 each. PASS: events (174 types), Knip,
changelog, Markdown, README structure, links, scoped supplementary ESLint with no
warnings, privacy and secret scans. The repository ESLint configuration ignores
infrastructure, so the supplementary run explicitly checked both changed code
files with the installed TypeScript parser and size/style rules.

Full workspace, package and development-stack typecheck: PASS. Exact-source [CI](https://github.com/elewa-git/opencrane-new/actions/runs/45101787415),
[application approval](https://github.com/elewa-git/opencrane-new/actions/runs/45101782539)
and [scanner approval](https://github.com/elewa-git/opencrane-new/actions/runs/45101785731): PASS. Full root tests were not run.
All tests, lint and typecheck used `nice -n 10`.

The rebase onto `origin/main` at `5576ecd1d` finished. The worktree stays available
for review. This receipt reports only the builder's checks.

## Standard fresh-stack attempt

PARTIAL. Both slots and package namespaces were free and load stayed below 6
for five full minutes, from 03:05:25 to 03:10:26 UTC. The final load was 3.25.
The run claimed slot 1 at 03:10:37 and started `up.sh --fresh --id 1`.
The server, website and model readiness endpoints returned HTTP 200. The launcher's
core browser journey produced workspace and upload screenshots at 1280 and 390 px.

Another worktree claimed slot 2 at 03:17:56 and started seven Compose containers.
The later observation recorded both stacks running and host load above 39.
The builder retained startup, service and browser evidence, then interrupted only
the owned core browser journey because the required single-journey condition no
longer held. This is an interrupted check, not a product PASS. The startup command
exited 1 after that interruption; the explicit status and `journey.sh --id 1`
commands are NOT RUN. `down.sh --id 1` passed and released the owned slot.
The other worktree's stack was not changed. All raw evidence stays outside the
repository in the private task receipt.

The later capacity window and full packaged journey are recorded below.

## Fresh packaged journey

PASS on 23 November 2026. The latest approved product was `2a5176965`. Its
exact-source CI, application approval and scanner approval passed; both approval
artifacts were present and unexpired immediately before preparation. The branch
was already based on the fetched `origin/main` at `5576ecd1d`; the rebase command
completed with “up to date”.

The second admission window ran from 03:40:29 to 03:45:58 UTC. Both secondary
slots and package namespaces stayed free, with one-minute load from 1.35 to 2.58.
The run claimed secondary slot 1, used fresh package storage, and supplied the
private values filename once through `PACKAGE_VALUES_FILE` to preparation. It
installed with the documented, logged
`OPENCRANE_ACCEPT_DEV_HOST_RISK=accepted-dev-box-366` setting for that one
`package-up` command. The saved installation record confirms the override and
F1/F2 refusals on both local nodes. Production host qualification is PARTIAL;
no host check was weakened.

| Condition | Result |
| --- | --- |
| Fresh guarded package, exact approved images and readiness | PASS |
| Six private-setting and three saved-setting install refusals before Helm | PASS |
| Wrong-organisation sign-in at 1280 and 390 px | PASS |
| No member or event from refused sign-in | PASS |
| First-owner claim, wrong-token and owner token-reuse refusals | PASS |
| Owner chat and Secure/HttpOnly cookies at 1280 and 390 px | PASS |
| Admin chat and Secure/HttpOnly cookies at 1280 and 390 px | PASS |
| Member chat and Secure/HttpOnly cookies at 1280 and 390 px | PASS |
| Member token reuse refused without changing owner | PASS |
| Production F1/F2 host qualification | PARTIAL; accepted local exception |
| Package removal, slot release and temporary test-app deletion | PASS |

The [safe results](packaged-results.json) retain each observed step and browser
check. Ten screenshots and 29 logs were retained in the private
task receipt before teardown. Both secondary slots now report free, and no
package namespace remains. The earlier interrupted Compose attempt above remains
PARTIAL; it is not included in the packaged PASS.

## Separate fresh development-stack check

PASS. A new five-minute admission window ended at 04:01:26 UTC with both slots
and package namespaces free and one-minute load below 6. The run claimed slot 1,
then `up.sh --fresh --id 1`, `status.sh --id 1`, `journey.sh --id 1` and
`down.sh --id 1` all exited zero. The fresh launcher and repeat journey checked
sign-in, chat, uploads and live view at 1280 and 390 px. The [safe command
results](compose-results.json) are separate from the packaged results above.
Startup and service logs were retained privately before teardown.
Both secondary slots report free. Generated browser captures remain in the
worktree for review; they are not part of the packaged qualification.
