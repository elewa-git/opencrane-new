# Event-only restore checks

Date: 25 October 2026. Source: `ef721c97a580ef9dcfd54e9b78462dd0e3ef8148`.
Base: `d3f6acfda` (#706, on main). Environment: this worktree, Node 22,
fresh disposable TLS NATS processes. No stack, model calls, host-network changes
or full root suite.

## Checks

- FAIL, expected: tests were committed first in `21669f748`. The initial run
  could not load the unbuilt restore module; no test cases executed in that run.
- PASS: `npm ci`; local tool symlinks point to the supplied NATS and lychee binaries.
- PASS: 47 restore/backup cases twice; the second run also passed all 438 event
  security cases. After test-only typing/lint corrections, all 23 restore cases
  passed twice again. Shared backup behaviour was unchanged by those corrections.
- PASS: full `nice -n 10 npm run typecheck` after correcting the fixture type.
- PASS: `nice -n 10 npm run check:events` (154 event types).
- PASS after repair: lint. The full ESLint scan found one unsafe test cast and
  25 existing warnings. The corrected test passed a focused ESLint recheck.
  All remaining lint tasks passed: dependencies, knip, documentation, README
  structure, links, fixtures, package licences and `npm run lint:changelog`.

The [test output](checks.txt) records the passing runs. Test code is in
[the restore cases](../../../libs/event-store/test/event-restore.test.ts).

The targeted runs used `PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`
and `nice -n 10 npx vitest run --maxWorkers=1` with these files:

- `libs/event-store/test/event-restore.test.ts`
- `libs/event-store/test/event-backup.test.ts`
- `libs/event-store/test/backup.test.ts`

`libs/events/test/security-rules.test.ts` ran once, alongside the second run.
These cases use NATS and schema checks; none connects to PostgreSQL.

PASS: absent-target restoration, retained range, ids/order and subject positions;
client restart before readback, stale-position refusal and one original command
following native deduplication loss. Corrupt/truncated input, descriptor mismatch,
same server, existing empty/populated/foreign streams and a racing creator refuse.
Timeout, partial transfer, changed restored identity, oversized reply and lost or
failed completion refuse without deletion or automatic retry. Executable output
is empty on success and contains fixed errors on failure, including injected
connection-close errors carrying a private canary. Owned fixture cleanup passed.

## Limits

This is event restoration only. The source must remain reachable and unchanged.
Targets are separate standalone NATS servers whose disposable use the operator
confirms. This does not prove installation ownership or isolation in Kubernetes.
Transport faults are injected around real requests; they are not disk-failure drills.

All-database/CNPG restore, object/volume ownership, current custody/deletion state,
rights/cents comparisons, outbound-effect suppression and reopening: NOT RUN.
Fresh-install and hosted restore journeys: NOT RUN. Full P5-8 needs complete live
P5-7. This partial event archive cannot authorise a full restore.
