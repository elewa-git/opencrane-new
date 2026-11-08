# Held Ask replacement: own checks

8 November 2026. Base: #935 merge `3424108682383dbebc7a0d91ffb957129db41d94`.
Source: `b1a4df9ed03c9768abc8319eb96ef8eac4445a74`.
The first test commit is `f8342fb0e`; its retained proxy test timed out because no
replacement was sent. The merged base includes the production reader link,
duplicate hold ownership check and retained byte limits.

The requester command now checks the saved non-dispatch attempt and asks the original
computer whether its Ask response still waits. It saves one retry event. The bridge
keeps watching the uncertain approval and wakes the original response after that
event. The computer claims the hold, renews its turn pass and sends its private
request bytes through the existing MCP proxy. The gateway requires the original
approval id and checks the current tool and spending rules before consuming one
new permit. A new message has no replacement binding. A lost reply permits no
further send.

This was an isolated worktree with `npm ci`, Node 22, disposable PostgreSQL, NATS
fixtures and a recording local upstream. The gateway fixture uses the pinned
binary linked from the main checkout. No owner stack, remote model or fresh
installation was used. The original request bytes stayed in the computer proxy;
the receipt records no request body.

## Results

- FAIL as expected before implementation: the first proxy test timed out while
  waiting for a replacement that did not exist. The test was committed first.
- PASS: the changed suites passed in two broad runs, 192 and 201 tests. The final
  run on all seven changed test files passed 205 tests with one existing skip.
  Its safe output is [changed-final.txt](changed-final.txt).
- PASS: the unchanged event security suite passed all 460 tests.
- PASS: workspace typecheck and the affected computer, server and models
  typechecks. Changed-file ESLint passed with no errors and four size warnings.
  Markdownlint checked 478 files with no issues.
- PASS: `check:events` matched all 164 event types. Knip and
  `lint:changelog` completed successfully.
- NOT RUN: the local full root suite and a fresh-install live journey. The root
  suite is left to CI. This source result does not qualify the live capability.

All Vitest, ESLint and typecheck commands ran under `nice -n 10`. The test runs
used a throwaway PostgreSQL database through `PG_TEST_URL`; it was removed after
the final pass. The first server suite attempt had a missing pinned gateway binary
in this worktree. Linking that fixture binary fixed setup before the passing runs.

## Caller status, Origin and expiry checks

8 November 2026. Source: `d657a68db`; failing-first test commit: `99a340b9b`.
The isolated worktree used a disposable PostgreSQL 17.6 container, local NATS
fixtures and the existing gateway fixture. No dev stack or fresh installation ran.

- FAIL as expected before the fix: all three focused regressions failed. A POST
  with the original cookie and valid CSRF token reached the step-up check despite
  a foreign Origin. A current participant could distinguish a saved call from a
  missing one. An expired uncertain call kept its waiting slot.
- FAIL during the first broad run: an existing approval POST test returned 503
  for a missing approval after the new missing-record error was introduced.
  The POST reader now maps that error to its existing 403 refusal. The focused
  test passed before the final runs.
- PASS: the final changed-suite command passed twice across seven files, with
  208 passed and one existing skip each time. The two summaries are in
  [changed-final.txt](changed-final.txt). The suites include the status, POST,
  bridge watcher, computer hold and proxy paths.
- PASS: workspace typecheck and a final server typecheck. Scoped ESLint had zero
  errors and one existing function-length warning. Markdownlint checked 482
  files with no issues. `check:events` matched 164 event types. Knip and
  `lint:changelog` completed successfully.
- NOT RUN: the local root suite and a fresh-install live journey. This is a
  source-ready result with live qualification still outstanding.

Vitest, ESLint and typecheck ran under `nice -n 10`. The disposable PostgreSQL
container was removed after the final test run.

## Earlier participant in caller status test

8 November 2026. Test commit: `2eb2fd677`.
Bob now joins the conversation before Alice makes her approval request. His
participation position therefore permits him to read that part of the history.
Only the check that the requester is Alice can refuse his status request.

- PASS: the focused test returned 403 for Bob with the requester check present.
- FAIL as expected: temporarily removing that check returned 200 for Bob, and
  the same test failed at its 403 assertion. The production file was restored.
- PASS: all seven changed test files passed twice, with 208 passed and one
  existing skip in each run. The summaries are in [changed-final.txt](changed-final.txt).
- PASS: workspace typecheck, scoped ESLint with no errors and four size
  warnings, Markdownlint with no issues, `check:events`, Knip and
  `lint:changelog`.
- NOT RUN: the local full root suite and a fresh-install live journey.

All Vitest, ESLint and typecheck commands ran under `nice -n 10`. Vitest used
the supplied PostgreSQL test URL and local fixtures. No dev stack was started.
