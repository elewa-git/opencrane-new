# Unavailable private bridge output

Date: 25 October 2026. Part of #97. Base: `f85834091`.
Failing-first test commit: `f9bd671a6`.
Implementation source: `e5939495295d41054496a187700b222c92a6633a`.

This is the first part of the requested delivery change, split to stay below the
600-line limit. The bridge discards memory-derived reply and reasoning text and saves
only unavailable status before acknowledging the original sequence. Direct report
writes still refuse private content. Invalid status text and command hashes still
close the bridge. Ordinary human messages and memory-free replies remain durable.

No private bytes are released in this part. Requester-bound server/browser RAM,
release-time reference and access checks, slow-subscriber and capacity refusal,
browser generation clearing and active invalidation remain follow-up work.
Memory admission stays disabled. No new event, API field or dependency is added.
The exact `RISKY_FIELD_NAME` rule was checked; its test and both authority test files
are unchanged. No memory command, installer or models index was edited.

The environment is this worktree with disposable NATS, OpenFGA and gateway fixtures.
PostgreSQL is a throwaway `postgres:17.6-alpine` container on a random loopback port,
with `PG_TEST_URL` set for each run. There was no fresh installation, real model call
or owner-stack change. Tests and all static checks use `nice -n 10`.

## Own checks

- PASS: `npm ci`, the requested tool links and the repository's normal pretest setup.
- FAIL, expected before implementation: the new bridge test received the permanent
  memory-content refusal instead of an acknowledgement and unavailable status.
  A preceding attempt had an invalid fixture field, corrected before the test commit.
- PASS: the first bridge regression after implementation. Expanded checks then found
  a missing test logger, corrected before the final runs.
- FAIL: the first broader run, 493 passed and 15 failed. Thirteen failures were setup
  errors from the missing gateway binary, resolved by the normal pretest command.
  Two bridge-replay checks failed: extra computer-history reads for finished chats,
  and a duplicate Stop before approval settlement with both reads delayed by 300 ms.
  These runs remain FAIL. The comparison below later reproduced both on main.
- PASS: all 438 unchanged event-security tests in that broader run.
- PASS: all 28 existing chat renderer tests, including text-free lost output.
- PASS: web production build, with existing size and CommonJS warnings.
- PASS: first complete changed-test run after installing the gateway fixture,
  22/22 tests in 254.43 seconds.
- PASS: those 22 tests again, in 246.93 seconds. The only intervening source edit
  expanded simple conditions onto separate lines. The test database was removed
  with its volume after both runs.
- PASS: `check:events`, 154 event types.
- PASS: full workspace and infrastructure typecheck.
- PASS: full lint, including Knip, dependency checks, documentation, links, fixture
  rules, package licences and changelog validation. Code lint has zero errors and
  25 existing function-length warnings.
- PASS: final focused code lint after expanding conditions and strengthening the
  digest assertion. The assertion now checks a known text-free report hash, so
  a hash influenced by incoming reply bytes cannot pass.
- PASS: all nine bridge-loss tests twice after that assertion, using a second
  throwaway database. That container and its volume were also removed.
- NOT RUN: full root suite, fresh-install delivery, process restart qualification
  and native qualification. The full requester-only delivery capability is PARTIAL.

Local logs use `/tmp/p4-15-pr3b-` followed by `red.log`, `green.log`, `expanded.log`,
`pretest.log`, `tests-1.log`, `tests-2.log`, `tests-3.log`, `web-tests.log`,
`web-build.log`, `events.log`, `typecheck.log`, `lint.log`, `lint-final-files.log`,
`final-test-1.log` and `final-test-2.log`.
The expanded tests cover real sockets, partly saved batches, lost acknowledgements,
cold history, projection replay and canary scans of saved reports, hashes and projection
logs. They do not qualify private output delivery or memory invalidation races.

## Main comparison after the CI failure

Own checks, 25 October 2026. `git fetch origin` and `git rebase origin/main`
completed. Main was `f858340914a3d411fc6e4cbf2d6703183787910d`, already an ancestor
of branch commit `7269d25a0c090413d66f331c0857aa7e32675da3`. No rebase was left
in progress. The comparison used a clean detached main worktree with its own
`npm ci` installation and the normal pretest tools.

Each attempt started a new Vitest process with `nice -n 10`, `--maxWorkers=1`
and the supplied `PG_TEST_URL` on loopback port 55432. A successful `SELECT 1`
checked database access before testing. Each process selected only the three
named cases from `takeover-http.test.ts` and `bridge-replay.test.ts`. The two
test files are identical on main and this branch. No assertion, deadline,
fixture, access check, money check or memory check changed.

| Check | Branch PASS / FAIL | Main PASS / FAIL | Finding |
| --- | --- | --- | --- |
| Overlapping identical takeover retries | 5 / 0 | 5 / 0 | CI failure not reproduced |
| Keep 30 finished chats unread | 5 / 0 | 4 / 1 | Existing main flake; left unchanged |
| Stop before approval settlement, both reads delayed 300 ms | 1 / 4 | 3 / 2 | Existing main flake; left unchanged |

The takeover CI failure from run `40239679646` on `7269d25a0` was
`AssertionError: expected 503 to be 202`. Ten selected runs did not reproduce
it. This is not proof that the failure is fixed or that it occurs on main.

The finished-chat case failed on main attempt 3 with
`AssertionError: expected 4 to be less than or equal to 1`, at the count of
computer-history reads in `bridge-replay.test.ts:693`.

The Stop case failed on branch attempts 1, 2, 4 and 5 and main attempts 3 and 5:
`AssertionError: expected [ { type: 'stop', …(4) }, …(2) ] to deeply equal [ { type: 'stop', …(4) }, …(1) ]`.
The received frames contain a second identical `saved-budget-stop` before
`approval_settled` with state `cancelled`. Both sides use the same sender, which
allows a repeat after one second until the computer confirms completion.

The main comparison justifies leaving both bridge checks unchanged as requested.
No behaviour change or new failing-first commit is needed for these findings.
Memory admission stays disabled. The existing tests still require private text
to stay out of saved reports, events and logs, and keep the two requesters separate.

Comparison logs are `/tmp/p4-15-pr3b-fix-branch-<attempt>.log` and
`/tmp/p4-15-pr3b-fix-main-<attempt>.log`, with attempts numbered 1 to 5.

## Complete-file checks after the comparison

Both runs used the same PostgreSQL URL, `nice -n 10` and one Vitest worker.
Each run passed all 109 tests. Run 1 took 354.70 seconds; run 2 took 376.64 seconds.

| Test file | Run 1 | Run 2 |
| --- | --- | --- |
| `memory-bridge-loss.test.ts` | PASS: 9/9 | PASS: 9/9 |
| `memory-reports.test.ts` | PASS: 13/13 | PASS: 13/13 |
| `takeover-http.test.ts` | PASS: 41/41 | PASS: 41/41 |
| `bridge-replay.test.ts` | PASS: 46/46 | PASS: 46/46 |

The complete runs add two passes to each selected case on this branch. They do
not erase the failed selected runs. The takeover case therefore passed seven
times here and five times on main without reproducing the CI failure.

- PASS: all 438 unchanged `libs/events/test/security-rules.test.ts` tests, once.
- PASS: full lint, including Knip and changelog validation; zero errors and
  25 existing function-length warnings.
- PASS: full workspace and infrastructure typecheck.
- PASS: `check:events`, with 154 event types in agreement.
- PASS: separate Knip and `npm run lint:changelog` runs.
- NOT RUN: full root suite, fresh-install journeys and native qualification.

Complete test logs and JSON results are `/tmp/p4-15-pr3b-fix-full-1.log`,
`/tmp/p4-15-pr3b-fix-full-2.log` and their matching `.json` files.
The event-security log is `/tmp/p4-15-pr3b-fix-security.log`.
Static check logs use `/tmp/p4-15-pr3b-fix-` followed by `lint.log`,
`typecheck.log`, `events.log`, `knip.log` and `changelog.log`.
The clean main worktree and its installed dependencies were removed after the
comparison. The tests closed their private service fixtures; the supplied
PostgreSQL service was left running. No owner stack or Docker settings changed.
