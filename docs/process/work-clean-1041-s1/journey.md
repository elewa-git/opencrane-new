# Capability-ledger fresh CORE journey

Journey on a fresh dev stack: PASS (core journey)

Latest tested head: `c51db8f86d99f9d4e02543d786bff1634f27b3b2`.
The first attempt below tested `9bf27f7e62b2080602a95d247b536e3b7cc529c7`.
Date: 17 November 2026 UTC. Branch: `work/clean-1041-s1`.
The later receipt commit changes documents and the failure picture only.

## Fresh installation and observed steps

Claimed secondary slot 2 through `infra/dev-stack/claim.sh`. Supplied the existing
Zitadel credential by file path. The owner stack was not used. Ran
`nice -n 10 infra/dev-stack/up.sh --fresh`, followed by
`infra/dev-stack/status.sh`, against `http://127.0.0.1:25206`.
The CORE runner uses Playwright from the installed dependencies at 390 and 1280 px.
No test or lint batch ran in this worktree during the journey. No paid call was made.
Startup through teardown ran from 14:25:08 to 14:34:22 UTC (9 minutes 14 seconds).

1. PASS: dev-only owner bootstrap and OpenFGA ownership.
2. PASS: managed provider setup switched calls on with the existing model stand-in.
3. PASS: website readiness, 86,831 ms.
4. PARTIAL: the signed-in member opened chat at 390 × 844 and sent the synthetic
   CORE prompt. The message appeared, but the reply failed. The UI showed
   “Reply failed” and “Didn't complete · nothing was repeated”.
5. FAIL: the unchanged chat driver waited 30 seconds for `.caret` at
   `infra/dev-stack/browser-chat.ts:33`. It never reached the completed reply,
   Stop, reload, upload, viewer, audit, budget or recovery steps.
6. NOT RUN: the 1280 px browser journey and its screenshot. The first width failed
   before the runner reached the second width. No substitute capture was made.
7. PASS: the following service status command exited 0. Healthy services do not
   turn the failed chat journey into a pass.

The [390 px failure capture](chat-390.png) was visually inspected. It contains the
synthetic prompt and failure state, with no visible credentials, email or private path.
This is a failure screenshot, not a completed-chat screenshot.

## Diagnostics and cleanup

Preserved the startup output, status output, host service logs, Compose container
logs, computer Pod logs and failure picture outside the repository before teardown.
The saved driver diagnostic records the caret timeout. The server log also records
an earlier NATS `TimeoutError` during a bridge poll. That earlier observation does
not establish the cause of this chat failure. The retained computer logs do not
provide a confirmed cause either. No retry, longer timeout or access change was made.

`infra/dev-stack/down.sh` exited 0. A subsequent status check reported `free`.
The worktree remains available. This failed regression journey does not change any
historical capability verdict copied into the ledger from committed receipts.
At that point the draft could not merge until a fresh CORE journey passed.

## Load-qualified rerun

Journey on a fresh dev stack: FAIL (core journey)

Tested head: `36b0df1a7fd30ad8e81224d02736beedc8bb8026`. Date: 17 November 2026 UTC.
After ten consecutive 30-second readings below 6, claimed secondary slot 1 and ran
`infra/dev-stack/up.sh --fresh`. Load was 5.46 at start and 15.70 when the run
failed. Bootstrap, managed-provider setup and website readiness passed; readiness
took 53,277 ms. The 390 px chat proceeded into the upload journey, where the browser
timed out after 120 seconds waiting for the uploaded-message reply to show Done.
The browser also reported transport failures. The 1280 px journey and later CORE
steps were NOT RUN. This does not reproduce the earlier first-chat failure, and it
does not establish that host load caused this failure.

The startup output and service logs were copied outside the repository before
teardown. `down.sh` exited 0, and the following status check reported `free`. This
was the single permitted rerun; no retry or timeout change was made.

## Load-qualified CORE rerun

Journey on a fresh dev stack: PASS (core journey)

Tested head: `c51db8f86d99f9d4e02543d786bff1634f27b3b2`. Date: 17 November 2026 UTC.
After eleven readings at 30-second intervals stayed below 6 for over five minutes,
claimed secondary slot 1 and ran `infra/dev-stack/up.sh --fresh`. The readings ran
from 16:19:26 to 16:24:51 UTC; each 1-minute load average was below 6. Load at startup
was 5.28. Bootstrap, managed-provider setup and website readiness passed; readiness
took 55,077 ms.

| UTC | 1-minute load average |
| --- | ---: |
| 16:19:26 | 3.64 |
| 16:20:02 | 3.04 |
| 16:20:32 | 3.23 |
| 16:21:06 | 3.54 |
| 16:21:36 | 3.80 |
| 16:22:11 | 4.29 |
| 16:22:41 | 3.80 |
| 16:23:14 | 4.34 |
| 16:23:44 | 3.67 |
| 16:24:21 | 3.15 |
| 16:24:51 | 4.70 |

The 390 px and 1280 px browser journeys passed. Both chats streamed a stub reply,
survived reload and retained Stop text. Both uploads passed after one upload retry;
the runner logged `net::ERR_FAILED` during upload transport twice. Live view, sign-in,
session and organisation refusals, audit, budget, replay, token-boundary, sign-out,
reauthentication and loopback-listener checks passed. The approval journey was skipped
because it waits for #45 rows 4, 5 and 14; it is not part of this CORE result.

No journey step failed, so there is no failure load. Load at the runner's completion
was 16.00. The stack was stopped with `down.sh`, which exited 0; the following status
check reported `free`. The start and teardown record is in the private task receipt
directory. This passing rerun does not remove either earlier failure record above.

## Own source checks

| Check | Result | Evidence |
| --- | --- | --- |
| Failing tests committed first | FAIL, expected | `24ee9c478`: all 13 cases failed because the checker did not exist. |
| Changed tests, twice | PASS | 13 tests in each run; Vitest 1.74 s and targeted `npm test` 1.78 s, at most two workers. |
| Capability checker | PASS | 59 rows; zero missing ids, duplicated ids or violations. |
| Typecheck | PASS | All workspaces, package and dev-stack checks. |
| Event catalogue | PASS | 174 event types agree. |
| Changed-file ESLint | PASS | Checker and test; zero warnings. |
| Knip and changelog | PASS | Two existing Knip configuration hints. |
| Markdown and links | PASS | Repository Markdown check with no file arguments; zero link errors. |
| Other lint subchecks | PASS | Debt, dependency boundaries, reads, READMEs, fixtures and package licences. |
| Preservation | PASS | Opening, Still NOT RUN and approval-listing measurements compared verbatim with the starting main. Size-debt measurements retained in prose. |
| Prompt budgets | PASS | Builder: 70 lines / 728 words; deploy: 34 lines / 306 words. |
| Full root suite and full ESLint sweep | NOT RUN | Local task instructions require targeted tests and changed-file ESLint. |
| Separate web tests and build | NOT RUN | No file under apps or libs changed; startup built and opened the website. |
| Independent review and hosted CI | NOT RUN | Left to the orchestrator. |

Checks, tests and builds ran under `nice -n 10`. The checker uses the standard
library, with no new dependency, catch, retry or raised limit. Parsing, row checks
and receipt checks are separate short named functions. The old mixed-status tables
were removed and linked at their historical commit; no receipt was moved or deleted.
The shipped-code diff is 101 added lines and zero deleted lines.
