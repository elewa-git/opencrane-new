# Group participant command checks

Date: 9 October 2026. Source: `2306b044a634332b07ac732b5091a872111ae341`.
Base: `19e4c01c6fded6fcd80e0049f3759672c24c0209`. Branch: `work/p4-5-pr4`.
The rebase completed. The base is an ancestor of the source commit.
Environment: disposable NATS, PostgreSQL and OpenFGA fixtures; `PG_TEST_URL` set.
The fixtures use fresh databases and event logs. These are service tests, not a
fresh installed silo. No full root test suite ran.

| Check | Status | Expected and observed result |
| --- | --- | --- |
| Test for the last participant slot with the NATS sequence condition disabled | FAIL, expected | Both additions were saved; the test required one append and one conflict. |
| Removed-author test with the participation check disabled | FAIL, expected | HTTP still returned 403, but the test found the group-send restriction instead of `ParticipationRefused`. |
| Four selected test files before correcting the test setup | FAIL | 74 passed; the foreign-member assertion reached the participant cap and returned 409. Moved this assertion to a smaller group. |
| Participant command tests, first run | PASS | All seven passed after correcting the test setup. |
| Participant command tests, second run | PASS | All seven passed again on the same source. |
| Lint, typecheck, event catalogue, knip, changelog | PASS | All passed; lint reported existing function-length warnings only. |
| First external review | PARTIAL | Requested stronger race and removed-author proofs. Both are addressed here; second review pending. |
| Successful group send, then removal | NOT RUN | Group sends are unavailable for active participants on this branch. |
| Fresh-install desktop and phone journey | NOT RUN | Group controls and the full browser journey remain separate work. |
| Full root test suite | NOT RUN | Excluded from this task. |
| Complete group-chat capability | PARTIAL | This change supplies participant commands only. |

The race starts at 96 participants. Both creator requests finish their access checks
and wait immediately before the real append to `participation-participants`.
Both pass the same expected stream sequence. The saved result must be one addition,
one HTTP 200, one HTTP 409 and exactly 97 current participants. A later stale edit
must return 409 without saving another event.

The send test records the error from the real HTTP access check. It first confirms
that an active participant reaches the group-send restriction. After a creator
removes the author, OpenFGA still permits posting. The access check must throw
`ParticipationRefused`. HTTP must return 403, and the conversation stream must remain
unchanged.
Both temporary guard removals were restored before the passing runs and commits.

The broader run selected server `chat-access-regression`, `direct-chat-http`,
`chat-read-regressions`, and protocol `chat-mode`. The seven participant command
cases then passed twice. They cover creator actions,
retries, the last participant slot, the cap, self-leave, cold history and the removed
author. Both runs used `PG_TEST_URL` and `--maxWorkers=1`.
All checks ran under `nice -n 10`.
Logs: `/tmp/p4-5-pr4-review1-red.log`, `/tmp/p4-5-pr4-review1-tests-1.log`,
`/tmp/p4-5-pr4-review1-participant-tests-{1,2}.log`, and `/tmp/p4-5-pr4-review1-<check>.log` for
`lint`, `typecheck`, `events`, `knip` and `changelog`.
