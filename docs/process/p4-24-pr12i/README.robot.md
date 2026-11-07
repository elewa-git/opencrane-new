# Routine Stop integration contract

Part of #106. Base: `f9d0f0ff8`. Failing-first commit: `b10baa69c`.
The first regression reached real native closure but found no interrupted finish.
A second regression held acknowledgement after credential preparation; saved Stop
still returned sent. It now cancels the original one-use start wait.
The follow-up source assertion found an extra delivery Stop. Recovery now verifies
and reuses the existing owner, admin or approval prohibition. Test commits also include
`ea66f44c8` and `e1ee8c039`.

The existing models process polls saved allocated routine roots with its budget actor.
Each Stop command and finish command retains its own one-stream append. The reaction
uses the first matching prohibition, so retries preserve its source. Finish still
checks the exact occurrence, allocation, people, private thread, computer generation,
server closure and native terminal evidence. Its final append also checks worker ownership.
Bridge recovery reads saved open starts for cancellation only. Replay invokes neither
Stop nor finish. There are no new event/API fields or dependencies.

The sender, composition, company connections and protected authority/security tests
are unchanged. Execution remains disabled. Owner Ask, company credentials, normal
success, process-exit evidence and fresh-install qualification remain later work.

## Own checks

Environment: shared development host, disposable NATS/OpenFGA/PostgreSQL and a scripted
native bridge. No model calls, owner stack changes or fresh installation.
All tests, lint and typecheck run under `nice -n 10`. No full root suite is run locally.

Own checks on 7 November 2026. Final source commit:
`2931bb10926ed607f327f941a7b74be4a7051b33`. The receipt-only commit follows it.

- PASS: full lint, workspace typecheck, event catalogue, Knip and changelog checks.
  Server typecheck and focused lint also passed after extracting closure checking.
- PASS: the first broad run passed 611 tests during implementation: routine sender,
  routine finish and all 460 unchanged security-rule tests.
- PASS: eight focused recovery checks after preserving the original Stop source.
  These cover held acknowledgement, lost replies, reconnect, late 1,234-cent settlement,
  native closure, timeout and connection loss. Six access/history checks and all 38
  unchanged hand-off tests also passed.
- PASS: final sender/finish repetition, 153/153.
- FAIL: initial CI on `256c46b3f` found three existing bridge replay checks rereading
  computer history for finished chats. The same three checks failed locally.
  This was a regression, not a permitted flaky-job retry.
- PASS after the fix: all 48 bridge replay tests, eleven routine lifecycle checks,
  and the reconnect check that requires Stop within two seconds. Recovery now reads
  once per connection while the existing Stop timer runs. Later starts use admission.
  Affected lint and server typecheck, Knip and the catalogue passed again.
- PARTIAL at receipt time: new-head CI is pending. The draft PR records its final result.
- NOT RUN: local full root suite, development stack and fresh-install live qualification.

The broad runs use a throwaway PostgreSQL database, supplied through `PG_TEST_URL`,
and one test worker. Logs: `/tmp/p4-24-pr12i-tests-{1,2}.log`,
`/tmp/p4-24-pr12i-{recovery-green,access,handoff}.log`,
`/tmp/p4-24-pr12i-{lint,typecheck-final,knip,events,changelog}.log`.
The CI correction uses `/tmp/p4-24-pr12i-cache-{red,green,bridge,routines}.log` and
`/tmp/p4-24-pr12i-cache-{lint,typecheck,knip,events}.log`.

## Completion before Stop polling

Rebased on `b5a2a2ba12074b693a26763a92bab488eba0759d` on 7 November 2026.
Failing-first test commit: `52940acbc`. Source fix: `5664293fd26ee4318145fb8905df2813ec7bde43`.
Six sender cases found zero finishes after Stop was saved and the native turn completed
before the bridge polled. A focused finish test refused the completed closure. Two native-report tests found that matched
completion lost its termination evidence, with and without file collection.

The computer now retains checked native termination on successful replies and in its
journal. The server copies it to the first computer closure. Finish accepts either
terminal status after checking the stopped allocation and every existing turn binding.
The outcome is interrupted: the accepted design's Stop row prohibits further work,
and its finish row releases the slot only after verified termination. Native completion
after saved Stop proves termination; it does not undo Stop or reopen the spending root.
Ordinary success without a stopped allocation still refuses. Older closures without
native termination evidence remain insufficient.

The changed status test now requires one interrupted finish across concurrent calls,
deduplication expiry and event-store restart. Both completed and failed closures without
native evidence must leave the occurrence occupied. The sender regression also restarts
the bridge and budget actor before cleanup, loses the finish reply, restarts the event
store and repeats cleanup. It requires one budget Stop, one finish and no occupied run.
Unmatched native turn ids never gain termination evidence. Journal reload keeps the marker.

Own checks for this correction use one worker under `nice -n 10`. Sender-only focused
checks used the supplied PostgreSQL URL; the complete suites use a throwaway PostgreSQL
17.6 container and disposable NATS
and OpenFGA fixtures. No development stack, model call or fresh installation is used.

- FAIL before the fix, as expected: six sender race cases, the completed-closure finish
  case and both matched native completion cases. The missing-evidence and wrong-native-id
  refusals passed. The tests were committed before the behaviour changed.
- PASS: 13 focused completion, evidence and recovery checks after the fix.
- PASS: 256 tests across routine sender, routine finish, native turn model, computer turns,
  bridge replay and Stop recovery. The complete command uses `npx vitest run` with those
  six files, `--maxWorkers=1 --no-file-parallelism` and the throwaway `PG_TEST_URL`.
- PASS: full lint (zero errors; 37 warnings), workspace typecheck, `check:events`,
  Knip through `lint:unused`, and `npm run lint:changelog`.
- PASS: second complete run of routine sender, routine finish and native turn model,
  178/178 tests. Each changed suite passed twice. The second command adds
  `--reporter=verbose` and otherwise keeps the same worker and database settings.
- NOT RUN: local full root suite, development stack and fresh-install live qualification.

Logs: `/tmp/p4-24-pr12i-fix-red.log`, `/tmp/p4-24-pr12i-fix-native-red.log`,
`/tmp/p4-24-pr12i-fix-evidence-red.log`, `/tmp/p4-24-pr12i-fix-green.log`,
`/tmp/p4-24-pr12i-fix-tests-{1,2}.log`, and
`/tmp/p4-24-pr12i-fix-{lint,typecheck,events,changelog}.log`.
The first native test attempt had a fixture method error; after correcting it,
`fix-native-red.log` records the two expected missing-marker failures.

The throwaway PostgreSQL container was removed with its volume after the second run.
