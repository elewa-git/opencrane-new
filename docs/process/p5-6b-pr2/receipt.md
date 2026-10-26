# Image part transport checks

Date: 26 October 2026. Part of #15, P5-6b PR 2.
Base: `7fb730399`. Failing-first test commit: `2b7333a5b`.
The implementation is the commit containing this receipt.
Environment: isolated worktree, Node 22, fresh npm installation, temporary TLS
certificates and ES256 keys. Scanner processes are simulated. No development
stack, model call, host network change or new dependency was used.

## Scope

Only the image-part HTTPS route is added. Responses prove one part's bytes and
echo the image bindings. The scanner image digest stays separate from the target
image digest. No event, image promotion, access rule or SQL rule changes.
Request UUID freshness remains the trusted caller's job; no replay store is added.

## Checks

- PASS: failing-first run refused valid image requests because the route was absent
  (10 failed, 38 passed). Negative-only passes in that run do not prove the guards.
- PASS: final image transport, upload transport, upload consumer and scanner launch
  suites twice: 190 tests per run. The first batch also passed all 438 unchanged
  security-rule cases (628 total). No PostgreSQL fixture is needed by these suites;
  the requested `PG_TEST_URL` was supplied.
- PASS: event catalogue and all 19 response field names checked against the exact,
  unchanged `RISKY_FIELD_NAME`. Both protected authority tests remain untouched.
- PASS: `npm run typecheck` and `npm run lint:changelog`.
- PASS: `npm run lint`, including Knip, documentation, links, fixture and licence
  checks. ESLint reports zero errors and 26 warnings in unchanged files.

The [image transport tests](../../../scripts/clamav-image-service.test.mjs) are the
repeatable artefact. The command was `node node_modules/vitest/vitest.mjs run`
with `scripts/clamav-image-service.test.mjs`, `scripts/clamav-service.test.mjs`,
`scripts/clamav-launch.test.mjs`, `scripts/upload-scanner.test.mjs` and
`--maxWorkers=1`. The first run also included
`libs/events/test/security-rules.test.ts`. Builder logs are
`/tmp/p5-6b-pr2-tests1.log` and `/tmp/p5-6b-pr2-tests2.log`.

TLS and ES256 verification are real;
clean/infected verdicts and scanner outage are fixtures. Tests interleave two
trusted silo identities; they do not qualify two deployed silos. Cancellation
checks retire the owned scan. A separate delayed-cleanup fixture checks that both
routes hold their shared slots and allow later uploads after cleanup completes.
All test and lint commands run under `nice -n 10`, with one test worker.

## Remaining qualification

NOT RUN: live clean/EICAR, fresh-install journeys, deployed issuer custody and
rotation, live outage/recovery and real two-silo isolation. Full image consumers,
image membership and complete coverage are later parts. Signature, vulnerability
and licence gates stay independent, and image admission stays closed. No full
root suite was run.
