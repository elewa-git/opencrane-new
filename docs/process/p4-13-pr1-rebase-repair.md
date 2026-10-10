# Memory rebase repair

Date: 10 October 2026. Source: `2bc3422a8db1abd85e9d9e97b2d807ca7a6c622a`.
This is local source evidence on the shared Linux development host, with Node 22.23.3.
The PostgreSQL endpoint was `127.0.0.1:55432`. Tests used disposable databases,
NATS, OpenFGA and agentgateway. This was not a fresh installation.
Local logs are in `/tmp/pr323-rebase-evidence/` on this host.

## Branch repair

PASS: discarded the unpublished rebase and restored published head `66c5f76a`.
PR #319 was still open at `85f1a462b360740c81ceaeb86c59a2a0186a0552`.
Rebased only the six commits after `4b5100f9` onto that dependency branch.
The first rebase finished. Documentation conflicts retain the current contracts and add
this PR's memory checks. PR #319 then merged at 18:26:11 UTC as `b7cf2e2d`.
Rebased those same six commits onto main. That rebase also finished, and its file tree
is identical to the earlier rebased source (`37d24c00`); no dependency commits remain
in this PR's own commit range. The Memory panel, workspace integration and keyboard helper
are identical to main at `b7cf2e2db28ade55de5cd1979226d94558756f1f`.

## Fairness investigation

The initial three isolated runs used rebased source `37d24c00` had two complete passes and one failure later
in the response assertion: `memory_unavailable` instead of `memory_busy`.
All three reached the required count of 13 within the unchanged 1,500 ms limit.
The initial three isolated runs on main at `08769be7` all passed.

Three more isolated runs on each branch passed. A temporary error trace found no
service refusal in those runs. Three further main runs passed while another
worktree's lint and regression tests were active; load averages were 6.38 to 6.55.
All runs used the same test selection, PostgreSQL endpoint and `nice -n 10`.
The temporary traces were removed.

FAIL, reproduced on both branches: the third five-file run had the exact 2-of-13
failure. Running the whole memory file on main at `b7cf2e2d`, without this PR's changes,
also failed at 2 of 13, with 96 other tests passing. Temporary timing traces show
11 flood writes each reading 136 saved events from the person's memory stream
in 2.34 to 2.37 seconds. Those reads happen before asking for a write slot. The unchanged assertion
requires append or completion within 1,500 ms. Log: `main-memory-full.log`.
The timing and error traces were removed after the comparison.

These writes have no dependencies. They return immediately from the new dependency
check. The changed reference checks add no lock or history read. Permission checks,
write slots, connection use and history-read ordering are unchanged by this PR.
New lineage tests run after the fairness and restart tests. The matching main failure
and the slow reads show that history left by earlier tests misses the time limit under
load. Existing history reads cause the delay, independently of this PR.
Failed runs remain FAIL; passing isolated runs do not replace them.

No production code changed during this repair. No check, assertion or deadline was
weakened. No new test was needed; the existing tests cover the reported behaviour.
The original test commits still come before their implementation changes.

## Validation

The five-file command was:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run \
  apps/server/test/memory.test.ts apps/server/test/memory-mcp.test.ts \
  apps/server/test/memory-recall-proof.test.ts libs/models/test/memory-rights.test.ts \
  libs/projections/test/memory.test.ts --maxWorkers=1
```

FAIL: first run, 223 passed and one failed. The restart-recovery case received
`memory_unavailable` on its initial write, before simulating a lost reply.
Both flood fairness cases passed. Log: `changed-tests-1.log`.

PASS: second run, all 224 tests passed. Log: `changed-tests-2.log`.
FAIL: third run, 223 passed and the exact 2-of-13 fairness failure.
Log: `changed-tests-3.log`.

PASS: first final run on `2bc3422a`, all 224 tests passed across five files.
Log: `changed-tests-4.log`.
PASS: second final run on the same source, all 224 tests passed across five files.
Log: `changed-tests-5.log`. Both runs include the whole memory file and its fairness cases.

PASS: lint, including Knip and `lint:changelog`. ESLint reported 15 warnings and
no errors. Knip reported two configuration hints and no unused-code failure.
PASS: typecheck across all workspaces.
PASS: check:events, 105 types agree. All checks ran under `nice -n 10`.
Logs: `lint.log`, `typecheck.log` and `check-events.log`.

NOT RUN: full root suite, deployment, fresh-install qualification and a new
independent review. This repair does not claim the memory capability is qualified.
