# Disposable file object restore

Part of #15. Uses the encrypted descriptor merged in #733 at `9e470b61e`.
The helper checks the matching archives and all files before creating storage.
It preserves addresses and MIME types, then reads back and hashes every object.
Stopped, exclusive ownership and the target silo are trusted operator declarations.
Private manifests remain trusted operator material. Only local MinIO is qualified.

## Checks

- Expected FAIL: `edb61df80` committed the first test before its module existed.
- PASS: 570 targeted cases, including all 438 unchanged event security cases.
- PASS: all 50 affected backup/storage regression cases again.
- PASS: full lint, Knip, typecheck, event catalogue, changelog and volume-cleanup checks.
- PASS: npm ci and the supplied tool symlinks. No dependency or event/API changes.
- Earlier setup timeouts and a cancellation rejection were fixed. Fixture requests now have deadlines and cleanup is registered before startup. Focused lint and typechecking passed after the fixture repair.
- PASS: all 35 restore cases twice after the setup repair (100.31 and 100.00 seconds).

Tests use disposable NATS and MinIO, `nice -n 10`, one worker and the supplied
`PG_TEST_URL` at port 55432; these suites do not connect to PostgreSQL.
No full root suite, development stack, model call or host-network change ran.

## Limits

PARTIAL — object recovery only; bytes grant no access. NOT RUN — volumes,
CNPG/WAL, all-database recovery, access comparison, current custody/deletion checks,
coordinated/live recovery and admission reopening. No scan or delivery starts.
