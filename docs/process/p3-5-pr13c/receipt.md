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
