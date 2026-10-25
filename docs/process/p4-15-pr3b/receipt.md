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
  These are outside the supplied flake list and remain FAIL.
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
