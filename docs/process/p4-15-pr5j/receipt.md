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

## Packaged runner fix, 30 October 2026

Source: the fix commit containing this receipt, following test commit `32a9c3ceb`.
The new package-image test first failed in all three cases: repository tests were
present, and both memory checks could not import the excluded server test helper.
The helper now lives in shipped runner code. Server tests import the same file;
all assertions are unchanged. The Docker build excludes repository test folders
and test files, including JavaScript tests and library fixtures.
The next image run found nested dependency tests and an absent fixture key directory.
The Dockerfile now removes those dependency test folders, and the test creates its
temporary key directory before calling the runner. No assertion was weakened.

The package test builds `infra/package/Dockerfile` with the real `.dockerignore`.
It calls each memory check from that image against fresh disposable NATS, using
temporary credentials and memory keys. No executable code is mounted. It checks
saved Correct and Forget events, affected-context invalidation, and disabled
admission. This is fixture evidence only; it does not qualify host safety or native
memory delivery. The existing entry-point test still checks the real host probe.

- PASS: 47 server invalidation tests, twice, under `nice -n 10` with one worker.
  A throwaway PostgreSQL container supplied `PG_TEST_URL` and was removed with its volume.
- PASS: all 192 collector and runner tests across nine files, twice, under `nice -n 10`.
  Both runs built the package image and executed both memory checks inside it.
  The suite also checked host refusal, timeouts, descendant cleanup and collector loss.
- PASS: lint, including Knip, dependency rules, documentation and licence checks;
  full workspace and collector typechecks; event catalogue and changelog checks.
  CPU-heavy checks ran under `nice -n 10`. Lint used the existing CI heap allowance.
- NOT RUN: full root suite and fresh-install live qualification. Admission stays disabled.
