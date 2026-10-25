# Event-byte export receipt

This source increment implements the event-only part of P5-7, under the accepted
backup contract steps 1–3 and D02/D06/D07. It does not implement stopping writers
or produce a complete backup set. Stable observed positions cannot prove that
all writers stopped. Full P5-7 still requires live P5-3 and P5-5.

The collector reuses the native NATS snapshot protocol from the existing restore
test and the operator entry reuses TLS/NKey connection setup. It changes no account
permissions, events, APIs, access checks, chart files or application entrypoints.
The descriptor is private local operator material. New names were checked against
`RISKY_FIELD_NAME`; no event/API schema or security test was changed.

## Own checks

- PASS: `npm ci`; existing pinned NATS and Lychee tools linked into the worktree.
- PASS: failing tests committed first as `00c777131` after rebase; the collector was absent.
- PASS: lint, full typecheck, event catalogue, knip and changelog checks.
  Lint used CI’s 8 GiB Node heap limit; existing warnings remain.
- PASS: 21 targeted backup tests twice and 438 event security cases, under `nice -n 10`.

Tests use disposable TLS NATS servers. The accepted archive restores on a separate
empty server, preserving records and command idempotency without consumer state.
Refusals cover concurrent writes, stream replacement, malformed or unfinished
snapshots, byte limits, deadlines, cancellation, connection loss, wrong silo,
existing paths, symlinks and non-operator identities. Checks include private modes,
cleanup, the ordered identity digest and synthetic canaries absent from descriptors
and executable output. No full root suite, live stack or model call was run.

## Snapshot failure checks, 25 October 2026

Source: `3132c2993cba1deb44f60fe9902639d06b7eb290`, rebased onto
`7b0f48cc8`. These checks used fresh disposable TLS NATS process fixtures in the
development worktree, with no installed stack.

- PASS: tests committed first in `662336504`. Before the fix, status 500 and
  408 final messages wrongly resolved after archive bytes had been written.
  Both refusal tests failed; the clean final-message test passed.
- PASS: after the fix, all 24 targeted backup and restore tests passed twice.
  Failure cases require a fixed error without the server's description, removal
  of the destination and a closed subscription. Clean completion requires the
  descriptor, matching archive size and checksum, and no partial files.
- PASS: full typecheck and `check:events`, both under `nice -n 10`.
- PASS: full lint, including knip and `npm run lint:changelog`, under `nice -n 10`
  with CI's 8 GiB Node heap limit. ESLint reported zero errors and 25 warnings.

Both full targeted runs used this command:

```sh
PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres nice -n 10 npx vitest run \
  libs/event-store/test/event-backup.test.ts libs/event-store/test/backup.test.ts --maxWorkers=1
```

The tests inject failure headers on the SDK message after real snapshot data.
They do not induce a disk failure or an acknowledgement timeout in NATS itself.
These tests use NATS only; they do not connect to PostgreSQL. No full root suite
or live recovery journey was run.

## Remaining proof

| Condition | Status |
| --- | --- |
| Event bytes and native restore in disposable process fixtures | PASS |
| Quiescing writers and draining projections | NOT RUN — not built here |
| CNPG backup/WAL and all three databases | NOT RUN — later work |
| Matched objects and computer volumes | NOT RUN — later work |
| Key/secret custody inventory and current deletion state | NOT RUN — later work |
| Coordinated set, isolated product restore and admission resume | NOT RUN — later work |
| Packaged fresh-install and managed recovery | NOT RUN — later live qualification |

A hard process kill can leave private partial files. Without `descriptor.json`
they are unusable. Existing destinations are always refused. This command provides
no encryption, durable off-machine storage, recovery-time promise or live journey proof.
