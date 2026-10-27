# Encrypted homes before offline recovery

Part of #15. Recovery is PARTIAL. Live recovery is NOT RUN.

## Inputs

The branch starts from `0ba702c6e3ed062e7ff812875f9de873d41da4b3`.
Required merged changes:

- #758: `0ba702c6e3ed062e7ff812875f9de873d41da4b3` adds the current-custody sequence.
- #759: `53f7bbcf0fb55d79442c634f176edbcce73503f1` exports every required home.

The accepted design is the Phase 5 backup contract, steps 4–6, P5-8 and
D02/D06/D09. The existing export format stays unchanged. No dependency, event,
public API field, chart, image or application access rule changes.

## Local checks

The first commit, `84ae213c7`, contains a failing test. A missing home export
incorrectly reached successful event/object recovery before the implementation.
The new check runs before either target receives bytes. Tests use real disposable
NATS and MinIO, production exports and synthetic Kubernetes ownership replies.

PASS: `npm ci`, `npm run lint` (including Knip), `npm run typecheck`,
`npm run check:events` and `npm run lint:changelog`. The unchanged security-rules
suite passed all 460 tests. The two changed suites passed all 73 tests twice on
the final code. Diff whitespace checks also passed.

All lint, typecheck and test commands use `nice -n 10`. Vitest uses one worker and
the requested `PG_TEST_URL`. These tests open no database; their probes prevent it.
The test files are `apps/server/test/recovery-restore.test.ts`,
`apps/server/test/recovery-custody.test.ts` and
`libs/events/test/security-rules.test.ts`. No full root suite ran.

The recovery tests exercise their effect probes before clearing the counts.
They require zero projection, handler, scheduler, model, tool, scan, delivery and
credential-release activity. Every bad-volume case checks zero event restore
requests, bucket creation and object writes. Successful fixtures restore the
original event identities and object bytes and still check current custody.
The empty-home custody fixture uses a real export with no computer claims.

## Limits

The validator authenticates, counts and hashes each saved home. It erases decrypted
chunks and returns no home contents. Checks cover exact inventory, archive hashes,
generations, file replacement, cancellation and the original recovery deadline.
Fixed errors and results contain no private input locations or home contents.
Input directories remain trusted operator storage; these checks do not prevent
later changes after validation ends.

Mounted ownership and extraction, CNPG/WAL and all database restore, full rights,
rows, audit and cents comparisons, credential renewal and reopening remain blocked.
No live stack, model call, full root suite or daemon/network change was made.
Fresh-install and live mounted recovery are NOT RUN. Source checks alone cannot
qualify coordinated recovery.
