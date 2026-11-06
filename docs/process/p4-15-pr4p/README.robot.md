# Forget delivery checks

Part of #97. Base: `0d70d25e302f1d8e9b81fdb31c78e1da05e9af29`.
Correct merged first at `24c82d1f5eda0bd8b9c71f401175b5613ab90871` (#893).
Remember and its Stop/replacement fix are included at
`4ae99f3d07ec15c3a576f5af4548f362add37b18` (#888).
The base also includes #812 (`52cec3f67`), #825 (`9ac1c6e3f`),
plus #830 (`e34543d5c`) and #883 (`7570a266c`). Tests were committed first as `67e6bbd7b`.

## Contract

An admitted personal thread may load the existing Forget definition when its policy
is reviewed, free and Allow. Each of the four tools can be selected independently,
in Recall, Remember, Correct, Forget order. Public discovery still lists Recall alone.
The existing signed proof must identify the exact loaded personal revision.

Forget uses the existing command, command/fact locks and one conditional append.
Qualification and full confirmation of access and the current turn retain the original
positions and deadline, including before append and before releasing the receipt.
History loads before the short access check. Later confirmation reads only new activity
and the small access streams. Unrelated turn activity still permits the operation.

The exact structured receipt confirms acceptance and that the fact is hidden.
It says cleanup is pending until saved cleanup evidence says otherwise. Recovery reads
only the original agent command; it sends nothing again, creates no keys and decrypts
no old value. Existing invalidation refuses old input and output. A new governed turn
cannot recall the forgotten fact, even while cleanup is pending.

## Own checks

Checked source: `1328b83b8`, 6 November 2026.
Environment: Linux, Node 22, disposable PostgreSQL 17.6, NATS and OpenFGA, real gateway,
backend, bridge and proxy, with a scripted native peer. No model runs.
`npm ci` completed; NATS and Lychee use the supplied local binaries.
All checks use `nice -n 10`. Each test run uses one worker and no file parallelism,
with at most two workers across runs. Fixtures create separate databases on the task-owned
PostgreSQL service through `PG_TEST_URL`.

Expected initial failure: all eight catalogue combinations containing Forget refused;
seven existing combinations passed. The joined backend test could not start its turn.
Log: `/tmp/p4-15-pr4p-red.log`.

After catalogue loading was enabled, nine checks failed as expected: three qualification
withdrawals saved a tombstone, and six delayed receipts escaped after withdrawal or expiry.
Two recovery cases also exposed an invalid cleanup fixture; it now supplies the required
worker identity. The other 52 cases passed. Log: `/tmp/p4-15-pr4p-guards-red.log`.

The first full affected run was FAIL: 759 passed and the first receipt was withheld after
one saved tombstone. Its unchanged isolated rerun also failed. A temporary timing probe
passed with 522 ms left on the original deadline; the probe was then removed. These runs
do not establish the earlier refusal cause. No assertion or deadline was relaxed.
Logs: `/tmp/p4-15-pr4p-tests1.log`, `/tmp/p4-15-pr4p-fresh-diagnostic.log` and
`/tmp/p4-15-pr4p-confirm-probe.log`.

The unchanged isolated case passed on continuation. No assertion or deadline was relaxed.
Log: `/tmp/p4-15-pr4p-resume-diagnostic.log`.

| Own check | Result | Log under `/tmp/p4-15-pr4p-resume-` |
| --- | --- | --- |
| Lint, including Knip | PASS | `lint2.log` |
| Typecheck | PASS | `typecheck.log` |
| Event catalogue | PASS | `events.log` |
| Changelog | PASS | `changelog.log` |
| Unchanged security rules, 460 tests | PASS | `security.log` |
| First affected batch, 519/524; Forget 37/37 | FAIL | `tests1.log` |
| Second affected batch, 523/524; Forget 37/37 | FAIL | `tests2.log` |
| Selected native regressions, 4/5 | FAIL | `regressions.log` |

The first batch's five failures and the native regression failure were in Correct. Five selected
cases passed with the original MCP code, four with current code, and five with diagnostics.
These controls do not establish the earlier refusal causes. Logs: `baseline.log`, `matched-head.log`
and `correct-diagnostic.log`, under the same prefix. No tracked source changed for these probes.

The second batch refused Forget after a deliberately slow IAM read. Its cause remains unproved.
GitHub CI will be reported for the pushed head. These local failures remain FAIL.

## Recovery and timing regression checks

Rebased on `fc8918d5e`. Checked test source: `1dacb84a9`, 6 November 2026.
This follow-up changes tests only. Production access checks and deadlines are unchanged.

Authenticated recovery now refuses a removed member, a different owner and a shared
scope. Human and other-agent events with the same command id cannot supply Alice's
receipt. Each read checks that no event was appended, no memory key was generated,
the key directory stayed unchanged and only the session cookie was decrypted.
The valid control recovers the exact saved id and timestamp.

The qualification race waits until Forget is saved, then holds the conversation read
inside the final confirmation. Removing qualification during that wait withholds the
receipt. Keeping qualification unchanged returns acceptance. Both cases retain one
saved tombstone. The existing trailing qualification check passes this test.

Correct lost-reply tests wait for the saved event before releasing its acknowledgement.
They separately require an immediate unknown result and a refusal after explicit deadline
expiry. Both recover the exact event receipt without another attempt. Slow preparation
uses a controlled clock and observes access starting after history or IAM preparation.
Separate cases expire the original deadline at append and require no saved change.
Both racing Correct commands read the same unsaved state. The second then reaches its
lock after the first releases it and must discover that first save through its locked read.

A bounded real-time run of the earlier Correct tests was FAIL: one passed and four failed.
Three failures were traced to access or lineage confirmation after the original deadline:
remaining time was -1 ms, -1 ms and -38 ms. The fourth failure's cause remains unproved.
This establishes those three diagnostic failures, not every historical refusal cause.
The temporary probe was removed. Log: `/tmp/p4-15-pr4p-fix-realtime-diagnostic.log`.

During fixture development, runs exposed a missing test organisation setting, an invalid
tombstone field, a collision fixture that forgot a loaded reference, and a preparation
observer that only watched the gateway. Those fixtures were corrected. One earlier run
also failed while waiting for the native test turn to start; its cause remains unproved.
The final checks below do not change those earlier results.

These runs used the supplied `PG_TEST_URL` and disposable test services, with a scripted
native peer and no model calls. All commands used `nice -n 10`. The test command selected
all 38 changed cases in `forget-backend-delivery.test.ts`, `correct-backend-delivery.test.ts`
and `memory-mcp.test.ts`, with `--maxWorkers=1`. The exact selection is in each log.
The other 270 cases in those files were not selected in these two runs.

| Own check | Result | Log under `/tmp/p4-15-pr4p-fix-` |
| --- | --- | --- |
| Changed cases, first run, 38/38 | PASS | `tests1.log` |
| Changed cases, second run, 38/38 | PASS | `tests2.log` |
| Full lint, including Knip | PASS | `lint.log` |
| Final changed-file lint | PASS | `final-code-lint.log` |
| Full typecheck | PASS | `typecheck.log` |
| Final server typecheck | PASS | `final-server-typecheck.log` |
| Event catalogue | PASS | `events.log` |
| Changelog | PASS | `changelog.log` |

The full root suite, development stacks and live qualification were NOT RUN.
Admission remains disabled. CI must check the new pushed head.

## Limits

Admission remains disabled. Both complete qualifications and the existing fresh-install
journey remain required. The queued admission, collector and journey files are untouched;
their work must await this split. No event/API field, dependency, SQL rule or image change.
The protected authority and security test files are unchanged.

Live qualification, complete disk/log leak scanning, development stacks, paid/model calls
and the full local root suite: NOT RUN. Shared/team native writes remain excluded.
