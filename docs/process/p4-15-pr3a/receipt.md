# Memory-bearing chat reports

Date: 25 October 2026. Part of #97. Base: `f34ccba16`.
Failing-first test commit: `23106c0b7`.
Implementation source: `c724e304afe9bed6a40f4a81515137c0a413955e`.
Environment: this worktree, with disposable NATS, OpenFGA and gateway fixtures and
disposable databases on the supplied PostgreSQL test service. No fresh installation.
No real model calls or owner-stack changes.

The report writer refuses text and command hashes when saved turn memory evidence
exists. Text-free loss and completion reporting still works. Private-context replay
excludes all assistant replies from that turn, including ones saved before recall.
The existing conditional append catches memory evidence saved during a report.

Own checks are recorded below. All tests, lint and typechecks use `nice -n 10`.
Tests use `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres` and one worker.

- PASS: `npm ci`; linked the requested NATS and Lychee tools.
- FAIL (expected before the fix): the corrected red run had 12 failures and one
  passing memory-free control. Reply, reasoning, batch and state checks demonstrated
  accepted content; cold replay reconstructed the canary. The bridge test was then
  corrected to ignore its initial resume message before checking report refusal.
- PASS: first targeted run, 41/41 tests across `memory-reports`, `private-context`
  and `shared-child-reports` (134.90 seconds).
- PASS: those 41 tests again, plus bridge batching and all 438 unchanged event-security
  tests: 480/480 (146.14 seconds). The bridge saved 2,700 reports in 4.56 seconds.
- PASS: 19/19 memory-report and private-context tests after extracting a small helper
  to keep the context builder within the complexity limit, twice (127.36 and 128.82 seconds).
- PASS: final memory-report file, 13/13 again (138.55 seconds), after the socket helper
  checked that its frame was a Buffer. The final changed test file passed twice.
- PASS: `npm run check:events`, 154 event types.
- PASS: full `npm run typecheck`, the final server typecheck and `npm run lint:changelog`.
- PASS: focused code lint, dependency checks, Knip, Markdown, README checks, local links,
  fixture rules and package licence checks. The socket fixture needed a Buffer check;
  focused lint passed after that correction.
- FAIL on earlier source: the full lint scan found only the context complexity and
  socket-frame issues corrected above.
- PASS: the final full `npm run lint`, including Knip and changelog validation.
  Code lint reports no errors and 25 existing function-length warnings.
- NOT RUN: full root suite, fresh-install governed recall and native recall qualification.

Local logs: `/tmp/p4-15-pr3a-red.log`, `/tmp/p4-15-pr3a-red2.log`,
`/tmp/p4-15-pr3a-green1.log` and `/tmp/p4-15-pr3a-events.log`.
The second run is `/tmp/p4-15-pr3a-green2.log`.
The helper follow-ups are `/tmp/p4-15-pr3a-final1.log` and `/tmp/p4-15-pr3a-final2.log`.
The final changed-file repeat is `/tmp/p4-15-pr3a-final3.log`.
Lint results are in `/tmp/p4-15-pr3a-focused-lint2.log` and
`/tmp/p4-15-pr3a-lint-stages.log`. Typecheck results are in
`/tmp/p4-15-pr3a-typecheck.log` and `/tmp/p4-15-pr3a-final-types.log`.
The full lint logs are `/tmp/p4-15-pr3a-lint.log` (before the fixes) and
`/tmp/p4-15-pr3a-lint-final.log` (PASS).
The first exploratory run also found test-helper errors, fixed before the test commit.
No new event or API name, dependency or authority rule is introduced.
Admission stays disabled. Volatile delivery, invalidation and native forwarding remain
later work. Existing stored ciphertext is not erased by this change.
