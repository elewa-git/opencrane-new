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

## First rebase and checks

Date: 11 October 2026. Tested source: `4005e90b`, with guide corrections only.
The environment was the same shared Linux host and PostgreSQL endpoint described above.
Logs are in `/tmp/pr323-final-rebase/`. This was not a fresh installation.

Before: the published branch ended at `fdd9dd35` and was based on `b7cf2e2d`.
Rebasing only its seven commits reproduced the stop at `5f5eac00` and all six reported
conflicts. The last documentation commit also conflicted in the server's agent guide.

PASS: rebased those seven commits onto `41dd9149570308bd1e2a6d7b9bde5fb214167e45`.
The commit comparison accounts for every original commit. No dependency commit was replayed.
Test commits still come before their implementations. No new behaviour was introduced
while resolving conflicts, and no assertion or deadline was weakened.

The server guide keeps member removal, departure details and turn previews, adds memory
link checks and describes the agent-write refusal. Its diagram no longer repeats arrows.
The model guides keep child joins, confirmed owners and preview permission checks. They
also explain that new facts need usable supporting facts and discovery offers recall only.
The model exports match main exactly, including both child-conversation helpers and
`memoryReferences`, which checks saved fact references without reading their text.
The memory-rights code keeps main's final permission recheck and does not read chat history
again. It removes only the unused discovery result that advertised agent writes.
The projection guide keeps initial-memory ordering and all current chat and owner behaviour.
It adds retention of links from every saved fact revision.
The server's agent guide keeps both the complete preview and reviewed-removal contracts
alongside the memory-input checks and this receipt.

Main's preview handler, routes, shared fact-validity helper, model exports and member-removal
code and tests are unchanged. The preview still allows at most 32 references and 16,384 bytes.
Each category reads at most 33 candidates. Saved grants and current requester and assistant
permissions are checked again before release. Unusable supporting facts are omitted.
Unrelated turn activity does not refuse readers. New human facts use the same validity
helper. Erased, expired, superseded, missing-key or invalid ancestors cannot support them.
Historical links survive repeated writes and replay. Agent writes remain refused because
a selective signed recall page cannot prove every reference loaded into a turn.

The same five-file command above ran twice, with `PG_TEST_URL` set and `nice -n 10`.
Both runs passed 239 of 240 tests. Both failed only the known slow-append fairness case:
2-of-13 in the first run, then 5-of-13 in the second. Each batch's one-file retry passed
all 119 tests. The batch results remain FAIL; both isolated retries are PASS. All other
focused tests passed twice. These runs include the private-preview cases added by PR #327;
those cases are unchanged. Logs are `changed-tests-1.log`, `changed-tests-2.log`,
`known-flake-rerun.log` and `known-flake-rerun-2.log`.

PARTIAL: the remaining package run was stopped after main advanced. It had reported
one failure in `apps/server/test/chat-http.test.ts`. The unchanged file then passed
alone on the same source. Its batch failure is not treated as the known memory flake.
The interrupted run has no complete totals. Logs are `package-tests.log` and
`chat-http-before.log`. The final source is tested again below.

PASS: lint, including Knip and `lint:changelog`; 15 existing warnings and no errors.
PASS: typecheck across all workspaces. PASS: check:events, 106 event types agree.
All checks ran under `nice -n 10`. Logs are `lint.log`, `typecheck.log` and `events.log`.
The final guide checks are recorded with the next rebase below.

NOT RUN: local full root suite, deployment, fresh-install qualification and another independent
review. The PR comment records the pushed commit and the final GitHub CI result.

## Package checks before the latest rebase

The seven commits were also rebased onto `158bf7dc40030f2a7dfe98c29e8564973f52ee5e`.
The memory implementation and tests were unchanged by this second rebase.
All runs used the same PostgreSQL endpoint and `nice -n 10`.
Logs for these runs are in `/tmp/pr323-final-rebase/latest/`.

PASS: the MCP, recall-proof, model-rights and memory-projection files ran twice.
Each run passed all 121 tests across four files (`other-memory-1.log` and
`other-memory-2.log`). The server memory file passed all 119 tests in its first run.
Its second run passed 118 tests and failed the known slow-append fairness case, 2-of-13.
The permitted one-file retry also failed that case, 2-of-13, with 118 tests passing.
Those two results remain FAIL. No assertion or deadline changed. Logs are
`memory-1.log`, `memory-2.log` and `memory-2-known-flake-rerun.log`.

FAIL: the remaining package batch completed with 1,898 tests passing, three failing
and six skipped across 135 files. The upload test exceeded its 180-second limit.
One model access test could not start its gateway readiness server. A model volume
case received a NATS timeout. These failures are not treated as the known memory flake.
The gateway's two chosen ports differed; the logs do not prove the startup cause.
Other worktrees were also running integration tests on this shared host.

PASS: the unchanged upload and model access files passed separately, all 82 tests.
The unchanged model volume file also passed separately, all 25 tests. No production
code, assertion, timeout or fixture was changed to obtain these results.
The batch remains FAIL. Logs are `package-tests.log`, `package-failures-isolated.log`
and `decision-cost-isolated.log`.

## Latest rebase and checks

PASS: rebased the same seven commits onto the latest fetched main,
`5f75ec5b971f23c756ee43004230bbfa78cd8a16`, which also adds provider draining.
The commit comparison still accounts for all seven original commits. Test commits
remain before their implementations. The memory code and focused tests are unchanged
from the second rebase. Only documentation corrections are added after the replay.

The server guide keeps provider choices and draining alongside turn previews and
memory-link checks. The model guide keeps approval changes, provider choices and
draining alongside checks on saved fact references. The server's agent guide keeps
its complete drain contract and the memory receipt. The model exports match this
main exactly. Provider admission, drain commands, spending and member removal code
also match this main. The preview's bounds and final access checks remain unchanged.

PASS: all 48 provider-draining and admission tests across three files.
Log: `final-main-provider-tests.log`. PASS: lint, including Knip and changelog validation,
with 15 existing warnings and no errors. PASS: typecheck across all workspaces.
PASS: check:events, 108 event types agree. Logs are `final-lint.log`,
`final-typecheck.log` and `final-events.log`.

FAIL: the first five-file memory run on this latest main passed 239 tests and failed only
the known slow-append fairness case, 2-of-13. Every invalid-input and bounded private
preview case passed. Log: `final-memory-1.log`.

FAIL: the second five-file run passed 238 tests and failed two MCP command-recovery
cases, `unknown` and `legacy`. All 119 server memory tests passed, including fairness.
The command helper had returned a refusal instead of the expected receipt. It catches
command errors, so this log does not prove the underlying cause. These failures are
not classified as the known fairness flake. Log: `final-memory-2.log`.

PASS: the unchanged MCP file passed separately, all 64 tests, including both failed
recovery cases. Log: `final-mcp-isolated.log`. The two five-file batches remain FAIL.
Every changed invalid-input, proof and recovery case, plus every bounded private
preview case, passed twice on this latest base; the recovery cases' second passing
result comes from the separate MCP run. No assertion, deadline or fixture changed.

PASS: documentation lint, offline links and changelog validation after the receipt
was updated. Logs: `final-docs.log`, `final-links.log` and `final-changelog.log`.
NOT RUN: local full root suite, deployment, fresh-install qualification or another
independent review. The PR comment records the pushed head and GitHub CI result.
