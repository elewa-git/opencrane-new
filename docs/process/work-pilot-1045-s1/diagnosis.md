# Fresh startup diagnosis

13 November 2026. Diagnosis: **PARTIAL — cause not proved**.
Both requested fresh starts passed. Neither reproduced the reported Spending
editor failure. No product change or proposed fix follows from these results.

## Controlled runs

The baseline used a separate detached worktree of `origin/main`, its own `npm ci`
installation and the existing tool binaries through local symlinks. Both runs used
claimed secondary slot 1, sequentially, the free model stub and `up.sh --fresh`
under `nice -n 10`. Neither run used the owner stack or a paid provider.

The launcher checked `/proc/loadavg` immediately before each claim. Neither sample
required the two-minute load wait. Both launches also set distinct
`P4_JOURNEY_ATTEMPT` values, so the later Phase 4 browser checks ran after the core
Spending checks in both installations.

| Run | Source SHA | UTC start–finish | One-minute load | Startup | Preservation | Teardown |
| --- | --- | --- | --- | --- | --- | --- |
| Main baseline | `7ec65e982f543f93b5829db39486cc8ca8eecfaa` | 18:14:03–18:28:27, 864 s | 2.26 | PASS, exit 0 | PASS | PASS, exit 0 |
| PR head | `2a479ed0ac84f37c3d9d7ffefcf54a7ef1c7ef13` | 18:30:03–18:47:07, 1,024 s | 4.80 | PASS, exit 0 | PASS | PASS, exit 0 |

The main SHA is also the PR's merge base and includes the personal-key change.
The temporary baseline worktree was removed after successful teardown. The PR
worktree remains for review.

## Spending evidence

Both console logs contain all four results below:

```text
PASS fresh 1280px: owner saves paying_group ceiling in UI; over-ceiling stub call refused and retained after reload
PASS fresh 1280px: owner saves assistant ceiling in UI; over-ceiling stub call refused and retained after reload
PASS fresh 390px: owner saves paying_group ceiling in UI; over-ceiling stub call refused and retained after reload
PASS fresh 390px: owner saves assistant ceiling in UI; over-ceiling stub call refused and retained after reload
```

Both runs also passed the final ceiling saves, the later Phase 4 browser journey,
member and catalogue replay verification, and form sign-out. Neither produced a
budget-editor failure log or screenshot.

During each core Spending journey, the browser observer recorded 18 successful
budget GETs and 15 successful budget POSTs, with no failed budget requests.
Across the completed PR run, including the later checks, it recorded:

| Observation | Result |
| --- | --- |
| `GET /api/org/models` | 19 responses, all HTTP 200 |
| `POST /api/org/models` | 15 responses, all HTTP 200 |
| `GET /api/org/effects` | 16 responses, all HTTP 200 |
| Failed transport for either Spending endpoint | 0 |
| Uncaught browser errors | 0 |

The upload fixture deliberately discards one successful upload response at each
viewport in `browser-upload.ts`. The PR console recorded the corresponding retry
at each width. The observer recorded two failed upload POSTs with
`net::ERR_FAILED`; both upload journeys subsequently passed. It also recorded
66 `net::ERR_ABORTED` requests during the whole run.
Those observations do not establish a Spending failure. Browser console errors
were retained, including output from the journey's refusal checks; they were not
reported as an empty console.

## Earlier failure and comparison

One recovered earlier task log contains this call sequence:

```text
Spending budget editor did not load; inspect private evidence
loadBudgetEditor → save → browserBudgetJourney
browser-budgets.ts:192 → :48 → :83
```

That places the failure while opening the editor before the paying-group ceiling
preparation save. It does not identify the viewport or loop iteration. The log has
no budget response statuses, failed-request details or editor visibility record.
The original page's network and rendering state cannot be reconstructed from it.

The Spending screen and read helpers, its existing `/api/org/models` handler and
`browser-budgets.ts` are identical between the baseline and PR head. The PR's chat
role, shared context schema, sign-out component and workspace template were present
throughout its passing fresh journey. This rules out a deterministic failure on
these two runs; it does not exclude an intermittent fault in main or an interaction
with the PR.

**Cause: unproved.** Neither conditional failure case in the diagnosis request
occurred. There is no demonstrated basis for blaming main, the personal-key merge
or one of this PR's changes. A regression test for the reported failure and a
smallest product fix are **NOT RUN / not established**. The original three failures
remain unresolved; these passes do not convert them into passes.

## Retained evidence and scope

The private launcher copied process logs, console output and browser observations
before `down.sh`, including on successful startup. It used protected directories
and files and the existing evidence sanitiser. The observer recorded navigation,
console output, uncaught errors, response statuses and failed requests. It recorded
no request bodies, credentials, headers or URL queries and added no browser reads,
retries or waits. It changed only the local installed Playwright entry point, which
was restored after the run; tracked product source was unchanged.

The general sanitiser redacts a field named `path`. The main copy therefore retains
redacted routes. The core Spending counts above were observed before cleanup. The
PR copy additionally retains the original private browser log and uses `route` in
its sanitised copy so URL routes remain available. No private location is published
here. Generated PR journey pictures and records were copied privately before their
tracked files were restored. No new pictures were published.

The workspace slice acceptance runner was **NOT RUN**: this task diagnosed core
startup only. No independent review result is claimed.

## Source checks

All commands ran under `nice -n 10` after both live runs had been torn down.

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS, including workspaces, packaging and dev-stack tooling |
| `npm run check:events` | PASS |
| `npm run lint:unused` | PASS; Knip reported two configuration hints |
| `npm run lint:changelog` | PASS |
| `npx markdownlint-cli2`, without file arguments | PASS |
| ESLint on changed code files | NOT RUN; no code file changed |
| New regression test for the startup failure | NOT RUN; failure not reproduced |
| Full root test suite | NOT RUN, as requested |

The only repository addition from this diagnosis is this receipt. No product fix,
dependency, new event or API field was added. No commit or push was made.
