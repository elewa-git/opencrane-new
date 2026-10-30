# Private memory runner checks

Part of #97. Tests were committed first in `47d586bb1`: 13 expected failures showed
missing execution and missing NOT RUN results.

- PASS: 120 changed collector tests and 47 shared server tests, each repeated.
- PASS: 460 event-security tests with the rules unchanged.
- PASS: full collector suite, 186 tests before three additional foreign-result cases;
  includes Docker timeout, descendant cleanup, collector loss and retry refusal.
- PASS: lint, full typecheck, collector typecheck, event catalogue, Knip and changelog checks.
  Lint used the existing CI heap allowance. CPU-heavy checks ran under `nice -n 10`.
- NOT RUN: full root test suite and fresh-install live qualification.

The runner now exercises Correct, Forget and unrelated fact changes against the
measured deployment's event store, using shared assertions and encrypted fixture facts.
Successful server checks remain PARTIAL. Seven other journeys and both complete
qualifications remain NOT RUN. All nine complete live memory journeys, native launch,
volatile replies and immutable deployment qualification remain outstanding.
Admission and both authority test files are unchanged. No admission is enabled.
