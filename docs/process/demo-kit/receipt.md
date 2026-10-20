# Demo group seed and owner guide

20 October 2026. Part of #32. Overall: PARTIAL. This is the first split within the
requested small-change limit. No product event, API, dependency or authority rule changed.

Base: `43cdd68d8b33cba943ca0a770700ae03a332b239`, including the merged real-provider switch.
Test-first commit: `bb3e6b1bb`. Both files failed before implementation because their
entry points did not exist. The recording API checks repeat and lost-response behaviour;
it does not prove a real service accepted a command.

The seed keeps the existing people, creates Acacia Trading and Kijani Logistics,
adds the same two people to both, and creates one Acacia supplier assistant.
Request records survive interrupted runs; an absent original receipt never permits
resubmission. It changes no ceilings and makes no paid call.

PDF fixture/upload, company ceilings, warm-up and the three-minute browser smoke are
left for the next part. No smoke command is advertised as implemented. The owner guide
is gated: main's real-provider switch currently rejects owner mode. A full fresh PASS,
the Stop image and owner-mode support are required before its refresh commands can run.

Owner stack, port 44200, owner data, phone, laptop tunnel and owner refresh: NOT RUN.
No owner command was executed. No live seed or paid call has been made by this task.
The single live stack lane is currently claimed by the Stop/image qualification.

## Own checks

Source: `a873b13fecdc20e9a1b7191f6b56d947c03189ad`. Documentation follows that commit.
All test, lint and typecheck commands use `nice -n 10`. Test commands use
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these fixtures do not
need a database. No root suite was run and no database was started.

| Check | Result | Time |
| --- | --- | --- |
| `npm ci` | PASS; existing audit findings retained | 43 seconds |
| Changed Node tests, final two runs | PASS; six each | 3.83 / 3.38 seconds |
| Event security rules | PASS; 438 tests, file unchanged | 3.33 seconds |
| Event catalogue | PASS; 149 event types | Not timed |
| New demo files, strict TypeScript | PASS | Not timed |
| Required workspace/package typecheck | PASS | About 6 minutes |
| Markdown and changelog validation | PASS | Not timed |

Removing the existing-request guard temporarily made the unknown-write test fail:
it observed two POSTs instead of one. Restoring the guard restored PASS. Both
recording fixtures use temporary directories and no live service credentials.
The broad optional dev-stack typecheck remains FAIL on existing daily-fresh,
mcp-journey, wake-latency and Zitadel-test errors. A new request-body typing error
was fixed before the separate demo-file check passed. Required workspace checks
are recorded separately; this does not hide that broader failure.

At 19:31 UTC the full lint command was still running: PARTIAL at this snapshot.
The pull request records its final result and CI on the pushed commit.

## Slot safety and CLI checks

20 October 2026. Source: `ea9f022c6`. These checks use disposable files and recording
fixtures. They do not qualify a live demo.

Fetch and rebase: PASS. `origin/main` was `43cdd68d8b33cba943ca0a770700ae03a332b239`
and was already an ancestor of the branch. Neither rebase state directory remained.

Test commit `25696b16d` came before the slot fix. Its regression failed because a
request for slot 2 called cleanup for the existing slot 1. The corrected launcher
checks the returned id and requested id before installing the cleanup trap. Startup
and seed failures still clean the secondary whose startup this run attempted.
The full explanation of what `--fresh` removes now appears before the owner commands.

CLI test commit `f4c91b3f2` uses the real configuration and session code with synthetic
settings in a temporary home. Its HTTP fixture cannot contact a running stack.
Removing each id, ownership or origin guard made its test fail. Loading configuration
before checking the id also made its test fail. Printing the synthetic provider
credential made the launcher's output assertion fail. All temporary changes were restored.

| Own check | Result |
| --- | --- |
| Changed Node tests, final two runs | PASS; 13 each, 31.05 / 30.50 seconds |
| Focused strict TypeScript check for demo files | PASS |
| Required workspace/package typecheck | PASS |
| Full lint, including knip, docs, links, fixture and licence checks | PASS |
| Event catalogue | PASS; 149 event types |
| `npm run lint:changelog` | PASS |
| Shell syntax and `git diff --check` | PASS |

All test, lint and typecheck commands used `nice -n 10`. The changed-test commands
set `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these tests do not
connect to PostgreSQL. No root suite or live journey ran. No stack was claimed or
started, no model call was made, and the owner stack was untouched. Live qualification
remains NOT RUN. The other test gaps and unfinished demo work remain as described above.
