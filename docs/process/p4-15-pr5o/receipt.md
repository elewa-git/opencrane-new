# Recorded replacement and fresh event reads

Part of #97. Built on `47709d225`, branch `work/p4-15-pr5o`.

The runner uses the production private-output lifecycle and chat reader. It records
computer loss and replacement, observes pending reply clearance, refuses recovery by
a fresh subscriber and rejects delayed old-generation frames. Fresh event reads retain
saved references and status without restoring execution or private input. An unrelated
context remains unchanged. The package fixture mounts only disposable credentials.

`replacementReload` is PARTIAL / complete=false. Other statuses and both qualifications
stay unchanged. Native replacement, browser reload, persistence and fresh-install
qualification are NOT RUN. Admission stays disabled. No bridge, web, computer, image,
authority or security-rule files change. No dependencies, event/API names or paid calls
are added. No stack or host settings are changed.

## Own validation

- PASS: `npm ci` and the existing NATS/Lychee tool links.
- PASS: failing-first commit `35b4d7881`; four runner cases failed before implementation.
  All eight initial focused server cases also failed with the helper absent.
- PASS: 14 focused server assertions twice on the final helper. Wrong old, replacement
  and unrelated state, retained bytes and unexpected sends are rejected. Replay starts
  no process or fetch request. The existing 80 invalidation and Stop assertions also passed twice.
- FAIL: first full explicit runner suite, 264 passed and one failed. The unchanged
  native-image case “shared process identity” failed its cleanup probe. That probe checks
  for remaining processes or homes and does not distinguish which remained. The fixture
  removed its disposable container afterwards. No native code was changed here.
- PASS: second full explicit runner suite, all 265 tests in 11 files. The native cleanup
  failure did not repeat. The first failure remains recorded; it is not a passing run.
- PASS: the seven package-image checks passed in both full runs. The image excludes
  repository tests, mounts only temporary credentials and keeps admission disabled.
- PASS: 460 unchanged event security-rule tests once.
- PASS: full lint, including Knip, dependency, documentation, link, fixture, licence
  and changelog checks. It reports 35 existing warnings and no errors. The initial
  socket typing and direct dependency findings were fixed before this passing run.
- PASS: workspace and infrastructure typechecks, the final server typecheck and the
  runner's explicit TypeScript project. Event catalogue: 158 matching event types.
- PASS: separate changelog check and diff whitespace.
- PASS: final focused repeat, 67 tests: seven package-image checks and 60 collector
  tests. This repeats the final shipped helper and the new falsely-complete child refusal.

Tests, lint, typechecks and image builds ran under `nice -n 10`. Tests used
the supplied disposable PostgreSQL URL and one worker.
The runner used `scripts/private-memory-qualification/vitest.config.mjs`; its direct
TypeScript check used `scripts/private-memory-qualification/tsconfig.json`.
Server and security tests used the root config with explicit file names. No full root
suite ran. GitHub CI is checked separately on the pushed draft PR head.

The new server checks pass. The first full fixture run remains FAIL because of the
native cleanup probe; the repeated full run passes. No fresh-install capability or
native replacement, browser reload or persistence qualification is claimed.
