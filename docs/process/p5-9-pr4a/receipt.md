# Checked recovery after an interrupted upgrade

Date: 27 October 2026. Part of #15. Recovery: PARTIAL. Live: NOT RUN.
Base: `039d6c5b9d82cf28604674728c0864d40e3cf27a`.
Failing-test commit: `b7c762527`. Source: `581a907e9fb33e3749f0e64f883fdf30817b3a98`.

## Inputs

Accepted design: Phase 5 backup steps 4–6, the upgrade paragraph, P5-9 and
D02/D06/D09. Required changes are merged:

- #714: `a40ff12ef`, handler interruption.
- #728: `2607ab2e0`, spending comparisons.
- #746: `834e9209d`, file and read comparisons.
- #751: `c3cea1c18`, combined offline restoration.
- #759: `53f7bbcf0fb55d79442c634f176edbcce73503f1`, home export.
- #758: `0ba702c6e3ed062e7ff812875f9de873d41da4b3`, current custody.
- #768: `32f426414f58249d87dcae87927b633e71903073`, complete home preflight.

## What this checks

The same handler upgrade is interrupted after its committed 256-event chunk.
The fixture calls the combined restore helper once with fresh registered targets.
It supplies the current event history separately from the unchanged archive. A
later deletion and current empty deletion markers prevent old material returning.
The successful home export is explicitly empty. A retained computer with its home
export removed refuses before bytes reach either target.

Only checked recovery reaches two deterministic rebuilds. They compare ordered
events, member rows, OpenFGA rights, full file rows and bytes, original reservations,
210 held cents and 70 settled cents. Later unrelated activity permits file reads;
member removal refuses them. These later events are outside the archive comparison.
Missing custody, recreated deleted material, changing inventories, incomplete
homes, corrupt archives and mixed attempts prevent replay and reads. Lost event
or object completion keeps saved bytes isolated and makes no retry.

The recording endpoint and each effect probe are exercised before resetting their
counts. Recovery starts no budget actor and makes zero model, tool, routine, scan,
delivery or credential calls. The incompatible-upgrade refusal and parked-job
checks remain. No product authority code or protected authority tests change.

## Checks

Environment: Node 22, this worktree, disposable NATS, MinIO and OpenFGA, and
PostgreSQL 17.6 in `pgtest-p5-9-pr4a`, on a random loopback port through
`PG_TEST_URL`. No dev stack, external model call or daemon/network change.
All lint, typecheck and tests run under `nice -n 10`; Vitest uses one worker.

PASS: `npm ci` and the requested tool links.
Expected FAIL: the first test reached manual restoration but observed zero calls
to `restoreRecoveryBackup`. This assertion was committed before implementation.
FAIL during implementation: all nine expanded cases reached the old assertion
that parked jobs exceed the 256 scanned events. Memory events do not enqueue these
handlers. The exact scan position remains checked; jobs must be non-empty, parked
and unchanged after incompatible resume. The corrected success case passed.

PASS: full lint, including Knip, documentation, links and licence checks; full
typecheck; check:events (156 event types); and changelog validation. ESLint reports
31 existing size warnings and zero errors.

PASS: 579 tests in seven files, including all nine changed cases and all 460
unchanged security-rule cases. This includes the existing budget, event and file
comparison tests, ahead checkpoints, combined restoration and current custody.
PASS: all nine changed cases passed again on the final source. The disposable
PostgreSQL container and its volume were removed afterwards.

The successful fixture compares 281 archived events, two file rows and 92 bytes
at checkpoint 281. Its separate current log has one later deletion. Both rebuilds
retain matching file hashes, original money identities and zero effect counts.
The [comparison output](fixture-summary.json) retains counts and hashes only.
The [commands](checks.txt) give the exact selected suites. No full root suite ran.

## Limits

PARTIAL: this is a disposable fixture, not a pinned-package upgrade or a fresh
installation journey. Home validation does not restore mounted volumes. CNPG/WAL,
all-database restore, credential renewal, reopening and live recovery are NOT RUN.
The fixture uses synthetic content and Kubernetes replies. Its effect probes
observe application entry points. No new CLI, event/API fields or dependencies.

## Backup ownership deadline fix

Date: 27 October 2026. Base fetched for this fix: `044e55d31`, including
`3763f17c7` (#764). The rebase finished; neither Git rebase state directory remains.
Failing-test commit: `c46ab0826`. Fixed source: `b5542c595999013c2f3db0aec3ff904960a54e9e`.

CI run `40466171098` failed the remaining-time assertion during target-node
ownership checks. The backup checker passed a remaining duration. The package
callback added that duration to its later start time, allowing a scheduling delay
to extend the original deadline. Every ownership command already received the
cancellation signal; that signal remains unchanged.

Expected FAIL: the new test delays callback dispatch by 40 ms and reaches the
existing assertion, “Each child must use the remaining time, including earlier
ownership checks”. This test was committed before the fix. The fix passes the
original absolute deadline through the callback into package and target ownership
checks. Each child receives the time left and the same cancellation signal.
The original assertion and all four original stalled-child cases remain unchanged.

Environment: Node 22.23.3, this worktree and the requested PostgreSQL test service
on loopback port 55432 through `PG_TEST_URL`. Suites create and drop their own
databases and use disposable NATS, MinIO and OpenFGA. Package command fixtures use
synthetic ownership records and command replies. No dev stack or full root suite ran.
Every lint, typecheck and test command uses `nice -n 10`. Vitest uses one worker;
Node test files run one at a time.

PASS: full lint (zero errors, 31 existing size warnings), full typecheck,
check:events (156 event types), explicit Knip and changelog validation.

The first combined Vitest command passed all 579 recovery and security tests in
seven files, including all nine interrupted-upgrade cases. Its 23 additional
gateway cases could not start because this checkout lacked the pinned gateway
binary, so that combined command exited with failure. The repository's
`fetch-tools.sh` downloaded and verified the pinned binary before the clean reruns.
The same CI run had a separate gateway publication acknowledgement timeout; its
access assertions and product code remain unchanged.

PASS twice: all 528 selected package, backup-checker and ownership tests, with
zero failures or skipped tests in either run. This includes all four original
stalled-child cases and the delayed-dispatch regression.

PASS twice: all 579 recovery and security tests in seven files. The clean second
combined command also passed all 23 gateway cases, giving 602 passing tests.
A separate gateway repeat passed all 23 again, including the team-removal case
that timed out in CI. No access, money or memory assertion was loosened.

The [comparison output](fixture-summary.json) was refreshed from the second
successful recovery. It retains 281 archived and recovered events, matching
rebuild results, original money identities and zero recorded effects.
The [commands](checks.txt) list the selected files and setup steps.

PARTIAL: recovery qualification remains as described above. Fresh installation,
CNPG/WAL, mounted home restoration, reopening and pinned-package upgrades remain
NOT RUN. CI after the push is NOT RUN by this task.
