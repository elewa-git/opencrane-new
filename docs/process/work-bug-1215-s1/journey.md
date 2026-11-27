# First send in a new assistant session

**NOT RUN** for a saved first message whose reply is lost, reload persistence
and Retry after connection recovery. The blocking journey gap remains.
The three style findings are fixed. The source checks below passed.

## Source and environment

- Date: 27 November 2026.
- Checked source: `810f7294a78874f98e0512da6abe1b5a9455a3cf`.
- Requested environment: a fresh packaged install in secondary slot 1.
- Requested Chromium sizes: 1280 × 900 and 390 × 844 pixels.
- No stack was claimed, installed or started in this round. No browser journey ran.
- Slot 2 is the protected pilot. It was excluded from the wait and left untouched.

## Why the journey did not run

The wait made 73 checks from 22:18:26 to 22:58:45 UTC. Each stack status command
used `DEV_STACK_ID=1` and `--id 1`. Slot 1 was occupied until near the end of the
wait. Once it became free, load repeatedly rose above 6. The longest period with
sampled load below 6 was 131 seconds; the required period is five minutes.

The safe start conditions were not met before the latest installation start
for this round. A later start would use the time kept for installation, browser
checks, log collection and teardown within the owner's round limit.
The raw wait log is `slot-wait.jsonl`. No startup or service failure logs were
needed because startup was not attempted. No teardown was needed.

## Required journey

The server must save the first message and return an appended receipt before
the browser driver discards that reply. A separate connection outage must keep
the original request ID for Retry. The check must count saved message events,
show one message after reload and run at both requested widths.

| Check | 1280 px | 390 px |
| --- | --- | --- |
| Server saves the first message before its reply is dropped | NOT RUN | NOT RUN |
| Reply recovery shows no uncertain-send warning | NOT RUN | NOT RUN |
| Reload shows the saved text exactly once | NOT RUN | NOT RUN |
| Retry checks the original request after connection recovery | NOT RUN | NOT RUN |
| Event store contains exactly one saved message | NOT RUN | NOT RUN |

The browser driver and read-only event check were prepared as `browser.mjs`
and `event-audit.mjs`. They did not run. No new screenshots were taken.

## Own source checks

| Check | Result |
| --- | --- |
| Focused server tests | PASS twice; 51 tests each run |
| Workspace tests after moving the helper | PASS twice; 119 tests each run |
| Complete typecheck | PASS |
| Event catalogue | PASS; 175 event types |
| Knip | PASS |
| ESLint on changed code | PASS; no warnings |
| Changelog | PASS |
| Markdown | PASS |
| Public privacy and secret scans before source pushes | PASS |

The [small check summary](checks.json) records timings and raw log file names.
All tests, typechecks and lint checks ran under `nice -n 10`. No full root test
suite ran locally. `origin/main` was fetched and was already included in the
branch, so no rebase was needed.

Both image approvals passed for the checked source, and their artifacts were
available:
[application](https://github.com/elewa-git/opencrane-new/actions/runs/46076744537)
and [scanner](https://github.com/elewa-git/opencrane-new/actions/runs/46076747717).
Image approval does not prove the browser journey.

The hosted [CI run](https://github.com/elewa-git/opencrane-new/actions/runs/46076749020)
passed checks, image fixtures, browser fixtures, all four test shards and the
final CI gate. Its result is PASS for the checked source.

## Earlier packaged checks

The earlier fresh install used source `267a650b3`. It showed a new session
without a warning and retained a draft after a failure before conversation
creation. Those checks passed at both widths. They did not save a first message
and lose its reply, so they do not qualify the required journey above.

| Earlier screenshot | 1280 px | 390 px |
| --- | --- | --- |
| New session | [1280](new-session-1280.png) | [390](new-session-390.png) |
| Failure before saving | [1280](network-failure-1280.png) | [390](network-failure-390.png) |

The [result summary](results.json) keeps those earlier checks separate.
The earlier package and slot cleanup passed.

## Work log

Expanded the three short branches into braced branches. Explained why the shared
identity guard stops callers from using another person's saved command as their
own. Moved the typing helper into the web test support folder and kept its type
limited to the fixture method it uses. Ran the source checks and waited for a
safe slot. Left the required live journey as NOT RUN and the PR as a draft.
