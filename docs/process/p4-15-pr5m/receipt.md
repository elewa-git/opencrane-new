# Simultaneous native process checks

Part of #97. P4-15 PR 5m. Own checks only.

The runner observes two pinned native processes at once. It checks their separate
homes and empty ephemeral threads, then checks that closing the first leaves the
second able to answer metadata requests with its original identity. Both process
and home removals are checked. No model input or memory text is used.

## Checks

- PASS: failing-first regression. The old single-process implementation returned
  FAIL where the two-process fixture required PARTIAL. Test commit `29f09f613`
  preceded implementation.
- PASS: full lint, including Knip, dependency, documentation, link and licence checks.
  There are 35 existing function-length warnings and no errors.
- PASS: workspace typecheck and the collector's explicit TypeScript project.
- PASS: event catalogue, with 158 matching event types, and changelog validation.
- PASS: 91 targeted tests in three files, twice on the final code. Each run includes
  41 native image cases, plus journey entry and container checks. Fault cases inspect
  liveness before removing their containers. Collector EOF uses the real supervisor.
- PASS: 460 unchanged security-rule tests, once, with PG_TEST_URL set as requested.

Tests, lint, typechecks and image builds ran under nice. No full root suite ran.
GitHub CI is checked on the pushed head and reported with the draft PR.

## Limits

Successful native assertions remain PARTIAL, complete=false. The four server checks
remain PARTIAL. Native recall, Stop/reconnect, replacement/reload and persistence
remain NOT RUN. Both complete qualifications remain NOT RUN.

The package lacks the native runtime and launch helpers, so it still refuses.
Disposable derivative images add the pinned runtime and production helpers only for
these tests. Distinct process metadata does not prove filesystem isolation. There
was no stack, paid call, deployment qualification, persistence scan or gVisor check.
Admission, product images, host settings, dependencies and server/computer source
remain unchanged. Collector EOF stops the group without a successful receipt;
abrupt cancellation can leave homes in tmpfs.
