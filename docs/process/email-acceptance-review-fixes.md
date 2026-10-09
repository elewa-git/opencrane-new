# Email acceptance review fixes

Date: 9 October 2026. Source: `99693f26ee96ce2f0a67d6cabf5570de93c4821d`.
The branch was rebased onto `f7239e69f959de2ae28b34877f2622d039f69559`, and
that main commit was confirmed as an ancestor after the rebase completed.

The checks ran on Linux with Node 22.23.3. Tests used disposable NATS fixtures,
PostgreSQL 17 through `PG_TEST_URL`, isolated databases and OpenFGA fixtures.
This was a local source check, not a fresh installation of OpenCrane.
Commands ran under `nice -n 10`; Vitest used `--maxWorkers=2`.

## Failing tests before the fix

Test commit: `cd35aa00`. The three new tests failed before the implementation changed:

- A join on another invitation during the final access check returned 200 instead of 409.
- Two simultaneous accepts by the same account returned two successes instead of one.
- An injected history of 10,001 older unrelated member events returned 503 instead of 200.

The races used invitations created through the HTTP route with real NATS and
PostgreSQL. Both invitations were absent from the delayed members projection.
The tests check the saved events, including that only one membership is joined.

## Passing checks after the fix

| Check | Expected and observed result | Status |
| --- | --- | --- |
| Focused Vitest run | All 217 tests in seven files passed | PASS |
| Changed tests repeated | All 155 acceptance and invitation tests passed again | PASS |
| `npm run lint` | Code, dependencies, unused code, Markdown, links, fixtures and changelog checks passed | PASS |
| `npm run typecheck` | All workspaces passed; the server passed again after the final helper change | PASS |
| `npm run check:events` | The catalogue and registry agreed on 98 event types | PASS |
| `npx knip` | No unused-code errors | PASS |
| `npm run lint:changelog` | The branch release note passed | PASS |

The seven test files were `apps/server/test/main.test.ts`, `shutdown.test.ts`,
`member-joined.test.ts`, `organisation-check.test.ts`, `invitations.test.ts`,
`groups.test.ts` and `libs/event-store/test/history-checked.test.ts`. The repeated
run covered `member-joined.test.ts` and `invitations.test.ts`.
The tests also check an active account with a different email, stale member status,
removal after the projection checkpoint and an incomplete recent-event read.

The first wider run had two fixture failures: the new saved-join fixture omitted
its invitation id. That fixture was corrected before the passing runs above.
Lint also caught excess complexity in the join function. A named function now
chooses its append condition; final lint passed without errors.

Local logs are `/tmp/p4-3-red.log`, `/tmp/p4-3-tests-pass1-final.log`,
`/tmp/p4-3-tests-pass2.log`, `/tmp/p4-3-lint-final.log`, `/tmp/p4-3-typecheck.log`,
`/tmp/p4-3-typecheck-server-final.log`, `/tmp/p4-3-events.log`, `/tmp/p4-3-knip.log`
and `/tmp/p4-3-changelog.log`.

## Conditions not tested

The full root suite was NOT RUN, as requested. A fresh-install sign-in and
acceptance journey and independent verification of the review fixes were NOT RUN.
The checks establish local source behaviour, not a completed live capability.
