# Image part consumer checks

Date: 5 November 2026. Part of #15, P5-6b PR 3.
Base: `6217c8718`. Failing-first test commit: `3fe8dfde4`.
Source: the implementation commit containing this receipt.
Environment: isolated worktree, fresh `npm ci`, Node 22 and temporary TLS/ES256
credentials. HTTPS and token verification are real; scanner verdicts are fixtures.
No stack, model call, registry publication or host network change was used.

## Checks

- PASS: the first test run failed because the consumer module did not exist.
  The test was committed before implementation. The first implemented slice then
  passed the two-silo clean/infected case through the existing HTTPS service.
- PASS: final client suite twice, 53 tests per run. Earlier regression batches
  passed 681 tests, including unchanged security rules, and 222 on repeat.
- PASS: typecheck, event catalogue, changelog and all 19 reply field names against
  the exact unchanged `RISKY_FIELD_NAME`. Protected authority tests are untouched.
- PASS: full lint, including Knip, documentation, links, fixtures and licences.
  Code lint reports zero errors and 37 warnings in unchanged files.

The [consumer test](../../../scripts/clamav-image-client.test.mjs) is the repeatable
artefact. Builder logs are `/tmp/p5-6b-pr3-final1.log`, `final2.log`, `tests1.log` and
`tests2.log` with the same prefix, plus `lint.log` and `typecheck.log`. Tests, lint and typecheck run
under `nice -n 10`; test suites use one worker and the requested `PG_TEST_URL`.
These focused tests need no database fixture. No full root suite was run.

## Remaining qualification

NOT RUN: fresh-install live clean/EICAR, deployed key custody/rotation,
live outage/recovery and deployed two-silo isolation. Image membership, complete
layer coverage and worker event wiring remain later work on #15. A clean part
cannot admit an image. Signature, vulnerability and licence gates remain separate.
