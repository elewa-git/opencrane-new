# Disposable file object restore

Part of #15. This helper checks the matching archives and all files before creating
the files bucket. It preserves addresses and MIME types, then reads back and hashes
every object. Only fresh local MinIO targets made by the recovery provisioner are
accepted. Restore checks the registered silo, the destination's owner marker and
running processes, and claims each instance once. Private manifests and Docker
administrators remain trusted. Restored bytes grant no access.

## Checks on 26 October 2026

Source: `1d93e4657`, rebased onto `6cc9d0e87`. The rebase finished and the fetched
main is an ancestor of this branch. Documentation changes follow that source commit.
Tests use fresh disposable NATS and MinIO containers, the existing pinned MinIO
image, `nice -n 10`, one worker and the supplied `PG_TEST_URL` at port 55432.
These suites do not connect to PostgreSQL. No full root suite or development stack ran.

- Expected FAIL: `6f048fd30` reproduced oversized 201 bucket and object PUT replies that did not close at the byte limit. Both unfinished-response cases already refused at the deadline.
- Expected FAIL: `ead638248` reproduced a destination endpoint/lease swap with unchanged declarations and another running process. Both restores incorrectly completed.
- Expected FAIL: the four marker/unmanaged-target cases in `4e2900be3` completed when the destination guard was absent. Restoring the guard fixes these cases.
- PASS: the first requested regression run, 118 tests across object restore, object backup, event restore and file storage (253.02 seconds).
- PASS: the same 118 regression tests again (234.45 seconds).
- PASS: all 438 unchanged event security-rule tests (2.94 seconds).
- PASS: event catalogue, Knip and changelog checks.
- PASS: full workspace and infrastructure typecheck.
- PASS: full lint (zero errors; 28 existing function-length warnings) and Docker volume-cleanup checks.

The [saved command output](checks.txt) records both regression runs and security checks.

The regression command is:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run \
  apps/server/test/object-restore.test.ts apps/server/test/object-backup.test.ts \
  libs/event-store/test/event-restore.test.ts apps/server/test/file-storage-failures.test.ts \
  --maxWorkers=1
```

The security command selects only `libs/events/test/security-rules.test.ts` with
the same environment and worker limit. The other checks are `npm run lint`,
`npm run typecheck`, `npm run check:events`, `npm run lint:unused` (Knip), and
`npm run lint:changelog`, each under `nice -n 10`.

## Limits

PARTIAL — object recovery only. NOT RUN — volumes, CNPG/WAL, all-database recovery,
access comparison, current custody/deletion checks, coordinated live recovery and
admission reopening. No scan or delivery starts. Remote S3 targets and adoption of
an existing storage installation are unsupported by this disposable-target helper.
