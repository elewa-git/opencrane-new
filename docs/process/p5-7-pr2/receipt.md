# Event-referenced object capture

Part of #15. This increment adds the object portion beside an existing event archive.
It does not complete coordinated backup or recovery.

The test-only commit is `d79e7c72c`. The first run refused the missing module.
A temporary no-op then failed the missing-object assertion with real disposable
NATS and MinIO. The implemented collector passed that same test.

## Own checks

- PASS: `npm ci`; the existing pinned NATS and Lychee tools are linked in this worktree.
- PASS: all 29 final object tests twice, plus 47 existing backup/restore tests.
- PASS: 438 event security cases; `check:events`, knip and `lint:changelog`.
- PASS: full workspace, package and dev-stack typechecking.
- PASS: full repository lint, including documentation, local links, fixture boundaries
  and package licences. Code lint reported zero errors and 26 existing warnings.

All tests and code checks run under `nice -n 10`. Tests use the existing CI glob.
The object cases cover missing and denied reads, truncated or changed bytes, wrong
counts and hashes, foreign addresses and subjects, conflicting duplicates, mixed
attempts, source-log or archive changes, cancellation, late errors, limits and unsafe
output paths. The denial uses a real narrower temporary MinIO lease. Late-error and
stalled-stream cases replace a response after opening a real MinIO read.
No full root test suite was run.

## Limits

The fixture uses local NATS and scoped MinIO. It checks captured bytes, including
a screenshot and two conversations, and injects selected response failures.
The operator must keep writers stopped; position checks do not prove that they stopped.
The disposable NATS target remains isolated and is never deleted by the helper.
No new dependencies, event types, API fields, access rules or SQL rules are added.
The existing risky-field rule was read and its test remains unchanged.

Coordinated backup is PARTIAL. Encryption, CNPG/WAL, computer volumes, object restore,
admission reopening, fresh-install recovery and full coordinated-set proof are NOT RUN.
No development stack, model call or host-network change was made.
