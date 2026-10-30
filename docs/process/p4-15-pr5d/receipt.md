# Initial personal load checks

## Repair checks

Date: 29–30 October 2026. Tested code: `6ca39742655093761e72b8820999e8fa7a01d706`.
The final rebase finished on fetched main `391d849f66e4ea645312391865fea2f70852f38b`.
The equivalent code commit is `31c3e8808`. A range comparison confirmed that every
code and test patch stayed unchanged. Only two README conflicts needed resolution;
both the new main documentation and the initial-memory documentation were retained.
Environment: this development worktree, the supplied PostgreSQL test listener, and
normal disposable NATS, OpenFGA, gateway and Docker fixtures. This was not a fresh
application installation. Every lint, typecheck and test command used `nice -n 10`.

| Check | Result | Observation |
| --- | --- | --- |
| Failing first | PASS | Membership failures were recorded in `b1a39dfe6`; collector failures in `d4d9ee73c`; nested membership refusal in `1e2630e63`. Final-read races were recorded in `d1b2afb2b`, and repeated membership history in `6dfa570b3`. Each test commit preceded its fix. |
| Initial delivery | PASS | 42/42 passed twice, in sequential runs after the final membership change. |
| Main memory and shared authority suites | PASS | 341 tests passed in both runs across six files. |
| Collector | PASS | 97 tests passed twice, including the real collector output shape, both complete qualifications, stale bindings and protected-file reading. Docker and filesystem observations were simulated; process cleanup used disposable containers. |
| Typecheck | PASS | All workspaces and infrastructure, final server and collector checks, and a full repeat after the final rebase. |
| Full lint | PASS | Full lint passed, including a full repeat after the final rebase. The final membership change and its test also passed a focused lint run. |
| Knip, dependencies, docs and links | PASS | No unused-code or dependency violations; documentation, README and offline link checks passed. |
| Event catalogue and changelog | PASS | All 157 event types agree, including after the final rebase; the branch fragment is valid. |
| Native qualification and delivery | NOT RUN | No live memory journey was run. Delivery and admission stay disabled. |
| Broader memory batch | FAIL | 966/969 passed. One nested-refusal regression and two MCP publication cases failed. The three selected MCP publication cases passed twice in isolation; no assertion or deadline changed. The full 224-case MCP file was not repeated. |
| Full root suite | NOT RUN | Only the requested focused suites and related memory/access tests ran. |

The six repeated memory and authority files were `apps/server/test/memory.test.ts`,
`libs/models/test/memory-context.test.ts`, `libs/models/test/memory-rights.test.ts`,
`libs/models/test/authority.test.ts`, `libs/models/test/authority-standalone.test.ts`
and `libs/models/test/authority-volume.test.ts`. The supplied database URL was
`postgres://postgres:test@127.0.0.1:55432/postgres`.

The membership regressions reproduced repeated permission decisions, a lost saved
removal and an applied demotion during snapshot preparation. A further regression
showed that loaded-reference checking wrapped an established membership refusal.
The qualification regressions reproduced acceptance of caller PASS objects, failure
to accept the collector's real output, and acceptance after installation or host changes.
The final-read regressions also showed that an access change or qualification withdrawal
could refuse the reply after a load had already been saved. The command now checks access
after deployment measurement and checks its protected files without waiting before saving.
Unchanged membership is confirmed by its original positions. Membership history is read
again only after a change, so saved removal remains decisive.
These failures were corrected without loosening the checks or their assertions.
The substituted-requester fixture now creates an active second member, so it still
reaches and tests the original identity refusal after membership is checked first.

One preliminary collector integration attempt was stopped during fixture setup.
The fixture now copies the actual process module before replacing only its Docker
boundary. That setup attempt has no claimed test result. No owner stack or Docker
daemon settings were changed.

Earlier overlapping runs returned command refusals before several initial-load test
scenarios could run. One also timed out while creating an OpenFGA fixture. A first
serial run passed 40/41. The final change removes redundant membership-history reads
without changing either access deadline. These earlier runs remain failed results;
isolated passes do not prove the cause of every earlier failure.

Logs: `/tmp/pr836-memory1.log`, `/tmp/pr836-memory2.log`,
`/tmp/pr836-initial-complete-1.log`, `/tmp/pr836-initial-complete-2.log`,
`/tmp/pr836-collector-final-1.log`, `/tmp/pr836-collector-final-2.log`,
`/tmp/pr836-mcp-diagnostic-1.log`, `/tmp/pr836-mcp-diagnostic-2.log`,
`/tmp/pr836-lint-final.log`, `/tmp/pr836-lint-last-files.log`,
`/tmp/pr836-typecheck.log`, `/tmp/pr836-types-complete.log`, `/tmp/pr836-types-last.log`,
`/tmp/pr836-post-rebase-typecheck.log`, `/tmp/pr836-post-rebase-events.log` and
`/tmp/pr836-post-rebase-lint.log`.

## Earlier slice checks

Date: 29 October 2026. Part of #97. Source base: `8eb69e0e3`.
Failing-test commit: `f93ba38f5`; the implementation is the accompanying PR diff.
Node 22.23.3; this worktree has its own `npm ci` installation. No dependency changed.
All checks and the secondary stack ran under `nice -n 10`.

| Check | Result | Observation |
| --- | --- | --- |
| Failing first | PASS | The new suite could not import the missing implementation; committed before production code. |
| Initial load suite | PASS | 27/27 twice, including memory-free refusal and retained references after lost replies. |
| Typecheck, Knip, Markdown and changelog | PASS | Workspace checks and focused file checks. |
| Lint phases | PASS | Code and dependency checks passed. Fixed a phase-coded README link; reran the failing and remaining phases successfully. |
| Combined targeted run | FAIL | 784/785 passed. Nightly-binding replay exceeded 30 seconds; this unchanged test is outside this slice. |
| Replay diagnosis | PASS | The failing case and its three setup cases passed in isolation; the full-file failure remains unresolved. |
| Event security, memory fold and admission | PASS | All selected tests passed; the protected files remain unchanged. |
| Event catalogue | PASS | 157 types agree. |
| Fresh installation | PASS | Claimed slot 1; empty local stand-in install, real SSO, readiness and loopback checks. |
| Human Memory journey | PASS | Save, search/detail, Correct, Forget and absence after reload; writes returned 200. |
| Signed-in isolation | PASS | Owner read a live fact; a separately signed-in nonmember received no fact. This does not test two admitted native turns. |
| Persistence scan | PARTIAL | Before and after pod replacement: 24 host state/log files and 85 computer files each; zero canary hits, unreadable files or computer-log hits. |
| Native recall, Correct and Forget | NOT RUN | Native launch and initial text release remain disabled. |
| Native A/B isolation and invalidation | NOT RUN | No memory-bearing native turn was started. |
| Host privacy prerequisite | FAIL | The development host reports 8 GiB of enabled swap. This run cannot qualify private memory. |
| Full enablement | NOT RUN | Complete current private-turn and private-memory qualification is still required. |

The first stack start lacked the setup credential path. The second used the existing
private credential file without printing it. The browser collector wrote only to a
separate temporary evidence folder. An immediate HTTP read after a later accepted
store returned 503 while the projection caught up; no write was resent.

The first targeted test attempt lacked the gateway binary. The repository pretest
script fetched it. The next run found a test fixture's extra silo field in strict
memory event data. The fixture was corrected before the final repetitions.

Native release and credential/input hooks are deliberately outside this split.
The load receipt returns status only, with dispatch disabled. The admission assertion,
authority tests, event security rules and neighbouring shared helpers are unchanged.
No new event or public API fields were introduced; the existing field names were
checked against `RISKY_FIELD_NAME`. No paid model calls were made: 0 euro cents.

The computer scan covered its home (including its PVC), temporary files, RAM files,
sessions, caches, outbox and logs. No crash dump was forced or qualified. The canaries came from human
Memory operations and never entered a native turn, so live model buffers, forced
crash dumps and attempted native persistence remain NOT RUN. Full privacy proof
remains NOT RUN. The final synthetic fact was forgotten before releasing slot 1.

Sanitised local run artefacts: `/tmp/p4-15-pr5d-final-1.log`,
`/tmp/p4-15-pr5d-final-2.log`, `/tmp/p4-15-pr5d-scan-before.json` and
`/tmp/p4-15-pr5d-scan-after.json`. Private browser artefacts are not committed.

The wider failure is `memory.test.ts`: “rebuilds binding status without any key, model, tool, computer or scheduler port”. The file matches the base revision. No timeout was raised and no assertion was weakened. Diagnostic log: `/tmp/p4-15-pr5d-replay-diagnostic.log`.
