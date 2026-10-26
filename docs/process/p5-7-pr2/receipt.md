# Event-referenced object capture

Part of #15. This increment adds encrypted copies of files referenced by a checked
event archive. It does not complete coordinated backup or recovery.

## Source and environment

Own checks on 26 October 2026 used implementation `31250e0c6`, rebased onto
`d45dd860c`. Git confirmed that the rebase finished and main is an ancestor.
The fixes follow test-only commit `00b88782b`.

Tests used new disposable TLS NATS processes, scoped MinIO, the existing upload
scanner fixture and local HTTP fault fixtures. This was not a fresh installation.
All tests and checks ran under `nice -n 10`; tests used one worker and the supplied
`PG_TEST_URL` at port 55432. No root or projection suite was run.

## Expected failures before the fixes

- Expected FAIL: 17 object cases failed and 28 passed. They exposed plaintext
  output, acceptance of missing or unsafe keys, absent authenticated restoration,
  and sockets left open after a capture deadline.
- Expected FAIL: both oversized-body storage cases failed; the existing HTTP 503
  case passed. The new cases require closure before an unfinished body can grow.

The first implementation passed all 45 object cases but failed three storage
cases: closing a bad response could leave the SDK's request promise pending.
The transport now reports that failure even if the socket has already closed.
The completed checks below include this correction.

## Own completed checks

- PASS: all 95 object-backup, backup, restore and storage cases twice.
  The two runs took 120.70 seconds and 99.50 seconds; the first also included
  all 438 unchanged event security cases, giving 533 passed tests.
- PASS: event catalogue validation, with 154 matching event types.
- PASS: full workspace, package and dev-stack typechecking.
- PASS: every repository lint stage, including Knip, dependency rules, docs,
  local links, fixture boundaries, package licences and changelog validation.
  Code lint reported zero errors and 26 existing warnings. Documentation lint
  first found an extra blank line; after removing it, documentation and all
  remaining lint stages passed. The already passing code stages were unchanged.

Test commands used `npx vitest run --maxWorkers=1` with these files:

- `apps/server/test/object-backup.test.ts`
- `apps/server/test/file-storage-failures.test.ts`
- `libs/event-store/test/backup.test.ts`
- `libs/event-store/test/event-backup.test.ts`
- `libs/event-store/test/event-restore.test.ts`
- `libs/events/test/security-rules.test.ts` in the first run only

Logs are `/tmp/p733-red.log`, `/tmp/p733-storage-red.log`,
`/tmp/p733-green-initial.log`, `/tmp/p733-storage-green.log`,
`/tmp/p733-tests-1.log`, `/tmp/p733-tests-2.log`, `/tmp/p733-events.log` and
`/tmp/p733-typecheck.log`, `/tmp/p733-lint.log` and `/tmp/p733-lint-remaining.log`.

## What the fixtures prove

Text and PNG files are stored as ciphertext and restore to their exact original
bytes. Every object has a fresh nonce. Capture refuses missing, public, linked,
short or long key files. Restoration refuses changed ciphertext, nonces, tags,
identities, hashes and keys before returning bytes.

HTTP fixtures withhold headers and send oversized or unfinished error and region
bodies. Tests require the sockets to close and incomplete output to disappear.
The ordinary storage tests also require oversized replies to refuse promptly.
Existing missing-object, count, checksum, scope, archive, history, private-mode
and stopped-writer assertions remain in place.

## Limits

The operator must keep writers stopped; position checks cannot prove that they
stopped. The key must be held separately and passed by path in process memory,
never through command arguments, logs or events. The restore helper returns
checked plaintext to its caller; it does not upload it or reopen an installation.
The disposable NATS target remains isolated and is never deleted by the helper.
No dependencies, event types, access checks, money checks, memory checks or SQL
rules changed.

Coordinated backup is PARTIAL. CNPG/WAL, computer volumes, restoration into the
object service, admission reopening, fresh-install recovery and full coordinated
recovery proof are NOT RUN. No development stack, model call or host-network
change was made. CI is left to the orchestrator after the push.

## Stronger refusal tests

Own checks on 26 October 2026 cover test-only commit `e4cf92df9`, based on
`d45dd860c`. Fetch and rebase completed; main is an ancestor and no rebase remains
in progress. Production code is unchanged.

Unfinished HTTP bodies now send 128 bytes every 100 ms. They stay below 64 KiB
through the one-second capture deadline. Tests require socket closure within a
further 500 ms, bound the total elapsed time and require the output directory to
be absent. Oversized-body fixtures keep their original rate.

The format test decrypts captured bytes directly with Node's AES-256-GCM. It
requires JSON `[identity, sha256]` as associated data and rejects decryption with
no associated data or just the identity. A separate fixture has a valid tag and
the expected plaintext length, but its plaintext has the wrong checksum. Direct
decryption succeeds; the restore helper must still refuse it.

- PASS: the five object-backup, backup, restore and storage files listed above
  twice, with 97 tests each, in 119.35 and 100.74 seconds.
- PASS: the initial object-backup run, with 47 tests.
- PASS: full typecheck and event catalogue validation (154 event types).
- Expected FAIL: removing the content hash from associated data in both writer
  and reader fails the independent format test at tag authentication.
- Expected FAIL: removing the restored length/checksum guard fails the
  authenticated wrong-checksum test because restore returns without throwing.

All commands used `nice -n 10`. Tests used one worker and the supplied
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The complete test logs are `/tmp/p733-fix-tests-1.log` and
`/tmp/p733-fix-tests-2.log`. Crypto mutation logs are
`/tmp/p733-verify-fix-no-hash-aad.log` and
`/tmp/p733-verify-fix-no-restored-count-or-hash.log`.
The full root suite and fresh-install recovery remain NOT RUN.

- Expected FAIL: removing the native request signal and socket timeout fails both
  unfinished-body tests because the error and region sockets remain open.
  Log: `/tmp/p733-verify-fix-no-transport-cancellation.log`.
- PASS: full lint, including Knip and changelog validation. Code lint reports
  zero errors and 26 existing warnings.
- PASS: all temporary production mutations were restored; the production diff
  is empty against `e4cf92df9`.

Static check logs are `/tmp/p733-fix-lint.log`,
`/tmp/p733-fix-typecheck.log` and `/tmp/p733-fix-events.log`.
