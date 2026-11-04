# Native private-process assertions

Part of #97. This is the first native runner slice; it does not qualify private memory.

The runner starts the pinned Codex executable through existing production helpers.
It observes an empty ephemeral thread, effective tool-free configuration, RAM home,
process identity and limits. It checks the process again before returning PARTIAL.
Host refusal remains decisive. No production computer, server or infrastructure file changes.

The package image excludes Codex and computer helpers. Its native check refuses.
A disposable derivative supplies those existing files for executable assertion tests.
Only its test loader substitutes host and bad native observations. No model call,
private input, dev stack, bootstrap or host setting change is involved.

## Own checks

- PASS: test-first commit `253e62d90` demonstrated missing-native refusal was absent:
  one expected failure and 48 passing tests before implementation.
- PASS: explicit collector Vitest config, 231 tests in ten files. This includes
  27 native image cases, all four saved-memory checks and supervisor cleanup.
- PASS: changed-test repeat, 77 tests in three files. The final test loader refuses
  to run if a fault-injection target no longer exists.
- PASS: full lint, workspace typecheck and the explicit collector TypeScript project.
  Lint reports 34 existing function-length warnings and no errors.
- PASS: Knip, check:events (158 event types) and lint:changelog.
- PASS: unchanged event-security suite, 460 tests, with a disposable PostgreSQL
  fixture and PG_TEST_URL set. The fixture and its volume were removed.
- PASS: native binary hash checked against the tarball integrity in the existing
  Codex lockfile. No dependency was added.

Commands used the collector's `vitest.config.mjs` and `tsconfig.json` explicitly.
Tests, lint, typechecks and image builds ran under nice. No full root suite ran.
GitHub CI is checked on the pushed head and reported with the draft PR.

## Incomplete work

- PARTIAL: privateTurns assertions when the native files and safe observations exist.
  The unmodified package cannot run them. Host-only results cannot pass.
- PARTIAL: requesterIsolation, sessionIsolation, invalidation and unrelatedActivity.
  These remain server checks, without live native execution.
- NOT RUN: nativeRecall, stopReconnect, replacementReload and persistence.
- NOT RUN: both complete qualifications, P4-14 and P4-15.
- NOT RUN: gVisor, other process namespaces, actual server/bridge/proxy RAM protection,
  live and fault-time scans, native caller/catalogue launch, requester-only volatile
  replies, native multi-session isolation and invalidation, and immutable fresh-install proof.
- Admission stays disabled. The collector cannot save PASS. The 5i journey remains held.
