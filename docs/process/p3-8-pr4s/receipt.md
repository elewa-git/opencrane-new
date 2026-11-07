# Explicit requester choice of company account

Part of #49. Base: `a4d267251`. Test-first commit: `0f582df83`.

The existing selection command records one company profile on the requester's stream.
It checks current membership, tool rights, opt-in, publication and verified evidence for
one exact profile revision. The event includes company ownership, generation and an
account identity digest. It contains no private account values or credentials.
An exact retry returns the original change, including after clear. Replay grants no
access and makes no custody, credential release or provider calls.

The verified-profile reader is synthetic test evidence. No live reader is installed.
Saved company bearers and unfinished consent remain unavailable. Personal remains the
interactive account mode. The existing personal reader cannot use a company choice,
even when a personal profile has the same id. No browser UI or sender is added.

## Own checks

- PASS: `npm ci` and the requested NATS and Lychee tool links.
- PASS: failing-first run before implementation, 18 failed and 10 passed cases.
  Two failures were later identified as an incorrect publication event in the fixture;
  the fixture now uses the existing `mcp.server_unpublished` event.
- PASS: final focused batch, 265 tests; changed files repeated, 77 tests.
  The corrected rotation fixture then passed twice, 32 company tests per run.
- PASS: 460 unchanged event security tests, full typecheck, changed-file ESLint,
  event catalogue (158 types) and changelog checks.
- PASS: full lint, including knip, documentation, links, fixtures and licences.
  It used CI's 8 GB Node heap after restarting the first run. Initial typing and
  personal retry errors were corrected before the final passing checks.
- FAIL: first CI at `532e6b3c2`; two receipt tests expected raw dependency text.
  Their corrected assertions use a private marker and require the sanitised error.
- PASS: corrected receipt file twice, 36 tests per run; its ESLint and server typecheck.
- NOT RUN: root suite locally and fresh-install live qualification. No dev stack or paid call.

The focused tests use disposable event-store, OpenFGA and PostgreSQL fixtures.
Tests run with the requested PG_TEST_URL and under `nice -n 10`.
No dependency is added. Protected authority and event security tests remain unchanged.
The credential broker, routine sender, memory and scanner are unchanged.
