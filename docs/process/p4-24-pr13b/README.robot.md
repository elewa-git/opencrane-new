# Offline expiry of one routine Ask

For people, read [README.md](README.md) first.

Part of #107, P4-24 PR 13b. This is the first offline-expiry part of accepted
design row 13. Execution remains disabled. No company Ask creation/use,
discovery index, cron, subscription or production caller is added.

`expireRoutineApproval(store, silo, input, options)` accepts routineId,
occurrenceId and `request: { eventId, position }`. The saved request supplies
approvalId; saved routine and preparation records supply owner, run and turn.
Options require `enabled: true`; `replay: true` always returns disabled.
The optional clock returns a Date. Expiry uses the original saved expiresAt.

History has a ten-second deadline before the two-second conditional append.
`readApproval` uses deferred invalidation and never opens the encrypted review.
A read-only view adds the proposed expiry after a captured log position so
`readRoutineApproval` can validate the same complete evidence that Stop requires.
This proposed row is never a saved receipt. The command appends once. When the
store reports `status: appended` with `outcome.kind: appended`, it returns that
event's id and acknowledged position immediately. A later read outage or expired
history deadline cannot discard this proven result. Duplicate recovery, an append
without an explicit outcome and conflict still require reading saved history.
Conflict causes a read, never a second append. An uncertain append returns
a fixed error; retry reads the original saved result. Saved expiry or denial
returns `confirmed`, eventId and position. Other states return `unchanged`.
A confirmed historical result remains readable after later Stop or completion.

Only the existing `approval.expired` payload is written, as the models system
actor. No event schema or HTTP API changes. Input/output names and approvalId
were checked against unchanged RISKY_FIELD_NAME; none carries private content.
No dependency, authority check, Stop module or package root README is changed.
The human and maintainer contracts for this addition live together here.

## Own checks

2026-10-29. Source: `5be0c9bce5964a9672532ea1802b20260675fa88`.
Environment: isolated worktree, Node 22, real disposable NATS and a recording local
upstream, with a controlled expiry clock. No owner stack or model call. Tests use
credential-free approval fixtures; they do not qualify company approval execution.

- FAIL before implementation: the temporary no-op produced 19 behaviour failures,
  two fixture failures and four passes. Test commit: cd4689e9d. The no-op was removed.
- PASS: 31 focused tests twice after fixing the fixtures. They cover the boundary,
  races, restart, lost replies, terminal reads, foreign bindings and replay.
- PASS: the new Stop integration retains uncertain holds, settles the full late
  1,234 cents, saves one Stop and records zero upstream bytes.
- PASS: 460 unchanged event security tests; check:events, knip and lint:changelog.
- PASS: workspace typechecks, with the server rerun after correcting the lost-reply
  helper's return annotation. Package and dev-stack checks ran separately.
- PASS: dependency, documentation, README, link, fixture and licence lint stages.
- PASS: full lint with CI's 8 GiB heap. The initial 4 GiB code scan was stopped.
  Focused lint passed after unsafe fixture casts and their replacement were corrected.
- NOT RUN: full root suite and fresh-install live qualification.

Commands used `nice -n 10`; tests used one worker and
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
These focused tests need only their own NATS fixtures and local recording listener.
Logs are `/tmp/p4-24-pr13b-final-tests1.log`, `final-tests2.log`, `tests1.log`
and the corresponding lint/typecheck logs with the same prefix.

Company use, lifecycle/recovery completion and live qualification still block
execution. The caller must compose saved expiry, Stop intent and budget cleanup
as separate commands. Offline replay must not invoke the live command.

## Own checks for acknowledged saves

2026-10-29. Fixed source: `81ecc0726bf9c5ae3e570e59a82c27e22e302a2c`,
rebased onto `3eb99aacf`. Both rebases completed with no remaining rebase state.
The test commit precedes the implementation commit. Node 22.23.3; isolated worktree
with disposable NATS, OpenFGA and PostgreSQL fixtures. This was not a fresh install.

- Expected FAIL before the fix: all three acknowledged-save cases lost the receipt
  after a position-read outage, history outage or expired read deadline. The two
  duplicate/conflict refusal checks passed. PASS after the fix: all five cases.
- PASS: all 36 expiry and expiry-to-Stop tests in each broad run. The approval suites
  had no failures; their existing 390px browser-control case remained skipped.
- FAIL: first `npm test -- routine approvals --maxWorkers=1` run on `5dc0b7806`
  after rebasing onto `e34543d5c`: 1,067 passed, five failed and one skipped.
  The failures were in unchanged routine-due, routine-sender and routine-session
  preparation steps, before their intended denial assertions.
- FAIL: second run on the fixed source above, with two workers and the verbose
  reporter: 1,065 passed, nine failed and one skipped. All five earlier failures
  passed. Four sender cases failed while starting their test turn; five session
  cases failed during their initial root allocation. These tests and their
  production code match the rebased main branch.
- PASS: all nine second-run failures when selected alone with one worker, using
  the same source, fixtures, deadlines and assertions. The other 463 cases in those
  two files were excluded by the name filter. This does not turn either broad
  run into a pass or establish the cause of the intermittent failures.
- PASS on the final base: lint, typecheck, check:events (157 types), Knip through
  lint:unused, and lint:changelog. No access, money or memory checks were weakened.
- NOT RUN: the full root suite, the skipped browser case and fresh-install qualification.

Every test, lint and typecheck command used `nice -n 10`. The broad and isolated
runs used `PG_TEST_URL` for a throwaway PostgreSQL container. It was removed with
its volume after testing. The focused failing-first run used the supplied test database URL.

Logs use the prefix `/tmp/p4-24-pr13b-fix-`: `red.log`, `green.log`, `tests1.log`,
`tests2.log`, `isolated.log`, `lint2.log`, `typecheck2.log` and `events2.log`.
The second-run failures cover exact-turn stopping, expired-output clearance,
clearance retries, slow admin evidence, lost manage access, Stop after allocation,
the 700-cent cap, an old permit after restart and the original access deadline.
Execution remains disabled. Hosted CI is left to the watcher after the push.
