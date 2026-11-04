# Simultaneous native process checks

Part of #97. P4-15 PR 5m. Own checks only. Updated 4 November 2026.

Source: rebased onto `64586a95c`, then test commit `26fe1ce54` and the cleanup
correction committed with this receipt. The rebase finished with no remaining
rebase state. The environment was the existing development host with disposable
fixture images and containers, not a fresh deployment.

The runner observes two pinned native processes at once. It checks their separate
homes and empty ephemeral threads, then checks that closing the first leaves the
second able to answer metadata requests with its original identity. Both process
and home removals are checked. No model input or memory text is used.

Cleanup now checks the recorded PID and Linux start time before each signal.
Repeated cleanup reuses its first result, including a failure. A replacement
process using an old PID is left alone. The image fixture uses named intermediate
values and ordinary multiline branches for process observations.

## Checks

- PASS: failing-first regression. All four new cases failed on the old cleanup:
  repeated cleanup, reused native PID, reused wrapper PID, and repeated failed
  cleanup. Test commit `26fe1ce54` preceded the implementation change.
- PASS: 95 targeted tests in four files, twice on the final code. Each run includes
  41 native image cases, four cleanup regressions, journey entry and container
  checks. Fault cases inspect liveness before removing their containers. Collector
  EOF uses the real supervisor. Runs took 760.48 and 428.09 seconds.
- PASS: full lint, including Knip, dependency, documentation, link, fixture and
  licence checks. There are 35 existing function-length warnings and no errors.
- PASS: workspace and infrastructure typecheck, plus the collector's explicit
  TypeScript project.
- PASS: event catalogue, with 158 matching event types, and changelog validation.
- PASS: diff whitespace check.

The targeted command used the collector's explicit Vitest configuration and
`native-cleanup.test.ts`, `native-image.test.ts`, `journey.test.ts` and
`journey-container.test.ts`. PG_TEST_URL was set to the requested fixture database.
Tests, lint, typechecks and image builds ran under nice. No full root suite ran.
GitHub CI results for the updated source are reported with the draft PR.

## Limits

Successful native assertions remain PARTIAL, complete=false. The four server checks
remain PARTIAL. Native recall, Stop/reconnect, replacement/reload and persistence
remain NOT RUN. Both complete qualifications remain NOT RUN. Collection and the
live journey remain held.

The package lacks the native runtime and launch helpers, so it still refuses.
Disposable derivative images add the pinned runtime and production helpers only for
these tests. Distinct process metadata does not prove filesystem isolation. There
was no stack, paid call, deployment qualification, persistence scan or gVisor check.
Admission, product images, host settings, dependencies and server/computer source
remain unchanged. Collector EOF stops the group without a successful receipt;
abrupt cancellation can leave homes in tmpfs.
