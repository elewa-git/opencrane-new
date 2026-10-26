# Authenticated upload scanner checks

Part of #15. This change connects uploads to the existing shared HTTPS scanner.
It keeps the existing file identity and checks exact bytes again before storage.
The wrapper also accepts that 64-hex file identity; request ids remain UUIDs.
Overall: PARTIAL. The broader integration checks below are not green.

- PASS: `npm ci`, local tool links, typecheck, event catalogue and changelog check.
- Expected FAIL: test-first commit `9b449ee89`; all 29 initial cases fail against TCP.
- PASS: the final HTTPS consumer suite twice, 36 cases in each run.
- PASS: wrapper, upload refusal, screenshot and daemon checks in both batches.
- PASS: unchanged event security tests once. Scanner result names also pass the
  exact unchanged `RISKY_FIELD_NAME`. The protected authority tests were not edited.
- PASS: full lint, including Knip, documentation, links and licence checks.
- NOT RUN: live clean/EICAR, deployed entry and key rotation, image consumers,
  browser screenshot qualification, full root suite and fresh-install qualification.

Both integration batches used `nice -n 10`, two workers and a throwaway PostgreSQL
container through `PG_TEST_URL`. That container and its volume were removed afterwards.
The first batch had 600 passing tests, four failures and 54 skipped tests. Its
member-guard setup lacked the pinned gateway binary; the existing fetch script
prepared it before the next attempt. Four access tests failed timing or status checks.
The second batch had 213 passing tests, six failures and one skipped browser test.
Five access tests failed: an OpenFGA timeout, two 1.5-second limits, a two-second
volume limit and a closed-history 503. Upload delivery history timed out after
computer restart. Member-guard tests completed, but cleanup missed NATS heartbeats.
These repeated or different failures remain FAIL. No access rule or deadline changed.
Logs: `/tmp/p5-6b-tests-1.log` and `/tmp/p5-6b-tests-2.log` on the builder.

The HTTPS tests use real TLS and signing with disposable certificates and keys.
They call `uploadFile` with controlled access, storage and command fixtures.
Separate integration tests use disposable services. Direct ClamAV tests keep the
old adapter under test support; they do not qualify the authenticated deployment.
Only test fixtures ran. No dev stack or external model call was made.
No runtime dependency, image, event or public API field was added.
