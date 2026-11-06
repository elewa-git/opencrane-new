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

## Limits

Admission remains disabled. Both complete qualifications and the existing fresh-install
journey remain required. The queued admission, collector and journey files are untouched;
their work must await this split. No event/API field, dependency, SQL rule or image change.
The protected authority and security test files are unchanged.

Live qualification, complete disk/log leak scanning, development stacks, paid/model calls
and the full local root suite: NOT RUN. Shared/team native writes remain excluded.
