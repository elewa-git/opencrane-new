# Provider choices at turn admission

Date: 9 October 2026. Branch: `work/p4-22-pr4c`.
Base: `origin/work/p4-22-pr4b`. Test-first commit: `feddd6a5`.
Environment: Node 22.23.3, local worktree, disposable NATS/OpenFGA/gateway services and PostgreSQL
at `127.0.0.1:55432`. This is not a fresh customer install. No paid provider calls.

The first part adds own/default admission after the recorded switch-on marker,
old-pass refusal and checks for a mode change before money is held. It adds no
production switch-on command or reaction. Safe migration, draining running legacy
turns, managed gateway activation and fallback-key startup refusal remain separate work.

| Check | Result |
| --- | --- |
| Failing-first tests | PASS: 7 failed, 12 passed before implementation |
| First broader focused run | PASS: 84 tests in 7 files |
| Final tests | PASS: 115 tests in 10 files; all 50 tests in the 4 changed files passed again |
| Lint, typecheck, event catalogue, knip and changelog | PASS; 100 event types agree |
| Independent review | PASS: two passes; fixed a read-count assertion and kept an existing error message |
| Binding revision guard | PASS: 1 selected test; 37 skipped intentionally |
| Reviewer long-chat and read-during-turn-start checks | PASS: 2 targeted tests |
| Full root test suite | NOT RUN, as requested |
| Fresh-install migration and managed dispatch | NOT RUN |

The final batch sets `PG_TEST_URL` and runs Vitest under `nice -n 10` with one worker:

```sh
npx vitest run apps/server/test/provider-turn-admission.test.ts apps/server/test/provider-bindings.test.ts apps/server/test/computer-turns.test.ts apps/server/test/turn-admission-cost.test.ts libs/models/test/provider-turn-contract.test.ts libs/models/test/provider-turn-guards.test.ts libs/models/test/provider-turn-replay.test.ts libs/models/test/decision-activity.test.ts libs/events/test/registry.test.ts libs/events/test/parse.test.ts --maxWorkers=1
```

Local logs: `/tmp/p4-22-pr4c-red.log`, `/tmp/p4-22-pr4c-focused.log`,
`/tmp/p4-22-pr4c-final-tests-1.log`, `/tmp/p4-22-pr4c-final-tests-2.log`, `/tmp/p4-22-pr4c-final-tests-3.log`,
`/tmp/p4-22-pr4c-lint.log` and `/tmp/p4-22-pr4c-final-typecheck.log`.
The pull request records the final source commit. These checks establish source
readiness for this slice, not completion of the managed-provider capability.
