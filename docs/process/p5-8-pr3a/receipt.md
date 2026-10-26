# Combined event and file restore

Part of #15. Status: PARTIAL. Coordinated live recovery: NOT RUN.

## Source and environment

26 October 2026. Branch `work/p5-8-pr3a` starts from
`834e9209d5272c7ad8711f28b3bff4cf29514616`. Prerequisites merged before implementation:

- #740 (`work/p5-8-pr2`): `c3e7ae2e2f675151c9f02be7743822324a022234`.
- #746 (`work/p5-9-pr3`): `834e9209d5272c7ad8711f28b3bff4cf29514616`.

The builder read the final reports and verification notes for both prerequisites,
plus the earlier native restore and encrypted object reports. This receipt records
only the builder's own checks. Test-first commit: `5754545c7`.
Implementation checked: `3a1e890eafea736ded5f01a6ee8dee53441943dc`.

`npm ci` completed in this worktree. NATS and Lychee use the requested existing tool
binaries. Tests use fresh local NATS processes and disposable pinned MinIO containers.
They start no product stack and make no model calls. No PostgreSQL fixture is needed
by these selected suites. Commands use the supplied `PG_TEST_URL` at port 55432,
`nice -n 10` and one test worker. No full root suite ran.

## Checks

Expected FAIL: the test-first suite could not import the missing implementation.
PASS: 97 tests across combined recovery, object restore and native event restore.
PASS: all 449 unchanged security-rule cases; 155 event types match the catalogue.
PASS: full typecheck, final test-file lint/typecheck and changelog checks.
PASS: all 33 changed cases again, after their pass in the 97-test regression run.
PASS: full lint, including Knip, with zero errors and 28 existing length warnings.
The fixture checks original events and file bytes, pre-mutation refusals, failed and
uncertain completion, retained data, refused retries and closed cancelled transfers.
Exercised recording probes count zero projection, reaction, scheduler, model, tool,
scan and delivery activity. The final tests and checks ran under reduced priority.

The regression command selects `apps/server/test/recovery-restore.test.ts`,
`apps/server/test/object-restore.test.ts` and `libs/event-store/test/event-restore.test.ts`
with `vitest run --maxWorkers=1`. The repeat selects only the first file; the security
run selects only `libs/events/test/security-rules.test.ts`. Other commands are
`npm run lint`, `npm run typecheck`, `npm run check:events` and
`npm run lint:changelog`. Full lint includes Knip (`npm run lint:unused`).

## Remaining work

NOT RUN: coordinated recovery on a fresh installation, volumes, CNPG/WAL,
all-database recovery, current deletion/key custody, recovery comparisons and
admission reopening. Local byte recovery cannot qualify these conditions.
The helper returns events-and-objects-only success and starts no product activity.
