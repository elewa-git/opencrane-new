# Recover a coordinated capture after an interrupted upgrade

Date: 27 October 2026. Part of #15. Recovery: PARTIAL. Live: NOT RUN.
Base and #772 merge: `6077ef801cd23bb8b21a1424ded2cd348e1ce813`.
Failing-test commit: `437a2a494`.

## Inputs and scope

Accepted design: Phase 5 backup steps 1–5 and the upgrade paragraph,
P5-7/P5-8/P5-9 and D02/D06/D09. The base includes comparisons from #746
(`834e9209d`), current custody from #758 (`0ba702c6e`), home checks from #768
(`32f426414`) and coordinated capture from #766 (`044e55d31`).

The fixture now captures events, files and two distinct non-empty homes together.
Capture uses separate empty NATS readers. Checked recovery takes those exact
three directories and a separately registered restore target. Current deletion
history remains separate from the archived history. Replaced manual collectors
are removed. The shared synthetic home helper exposes its existing readers.

The 256-event handler interruption and unchanged parked jobs remain checked.
After authenticated restoration, two rebuilds compare ordered events and positions,
member rows, rights, file rows and bytes, original reservations, 210 held cents and
70 settled cents. The successful fixture has 287 archived events and 255 parked
jobs at the interruption point. Foreign and revoked readers remain refused; unrelated activity
preserves reads. Each effect probe is exercised before its count resets to zero.

Corruption during the second home copy, resumed writers, original-deadline expiry
and cancellation prevent restore and comparisons. Missing homes, either damaged
home tag, corrupt events and mixed attempts prevent restore writes. Missing current
custody, recreated deleted material and changed inventories prevent replay.
Uncertain event or object completion remains isolated without erase or resend.

## Own checks

PASS: `npm ci` and the requested NATS and Lychee links.
Expected FAIL: the initial success test observed zero coordinated captures.
It was committed before implementation. PASS: that test after wiring coordinated
capture and two homes. Expected FAIL: the added copy-corruption case initially
reached a successful capture instead of refusing; fault injection was added next.

Environment: Node 22, disposable NATS, MinIO, OpenFGA and PostgreSQL 17.6.
PostgreSQL uses `pgtest-p5-9-pr4b` and its allocated loopback port through
`PG_TEST_URL`, following the throwaway-database instruction. All lint, typecheck
and test commands use `nice -n 10`; Vitest uses one worker without file parallelism.
No dev stack, full root suite, model call or daemon/network change.
The [commands](checks.txt) record the selected checks.

PASS: full workspace typecheck, check:events (156 event types), explicit Knip
and changelog validation. An interim package typecheck rejected the test clock’s
TypeScript annotation; that annotation was corrected before the full check.

The first lint run refused two machine-specific home paths in the command record.
They were replaced with a placeholder, and the privacy check passed.
PASS: 594 tests in the first shared regression batch, including all 460 unchanged
security-rule cases. PASS again: the other 134 tests across six files. This covers
shared home readers, combined recovery, current custody, coordinated capture and
event, file and budget comparisons. PASS twice: all 15 upgrade cases.

PASS: full lint, including documentation, local links, fixture boundaries and
package licences. ESLint reports 31 existing size warnings and zero errors.
In total, 149 selected tests passed twice and 460 security-rule cases passed once.
The throwaway PostgreSQL container and its volume were removed after the tests.
`git diff --check` passes. CI is not awaited for this draft PR.

## Limits

PARTIAL: validating encrypted homes does not restore mounted volumes. Synthetic
Kubernetes replies do not prove mounted ownership or stopped live writers.
CNPG/WAL, all-database restoration, the full manifest, live quiescence, credential
renewal, reopening, fresh-install recovery and pinned-package upgrade are NOT RUN.
Production restore/export, access rules, protected tests, CNPG, image and cluster
files are unchanged. No new event/API fields or dependencies.
