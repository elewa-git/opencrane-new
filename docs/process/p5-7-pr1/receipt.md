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
- PASS: failing tests committed first as `af8dd62dd`; the collector was absent.
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
