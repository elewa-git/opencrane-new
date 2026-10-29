# Initial personal load checks

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
