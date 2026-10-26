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

## Provisioning privacy checks — 26 October 2026

Implementation: `a8c7b60149b20b8c31d1972f29166ae93473456e`.
Rebased onto `90a95dff659b5840c76e4b969f1f75775fea76e7`; the rebase completed.
The README conflict kept the computer-volume checks and combined restore description.
The environment is this worktree with disposable test services, not a fresh install.
No dev stack was started or claimed.

Expected FAIL: test commit `d78fc399d` exposed the private directory in NATS arguments.
Fix `4c854d7a6` passed the same test using a relative configuration filename and a
private working directory. Expected FAIL: test commit `a315006e3` exposed raw paths
in eight setup and cleanup cases. The implementation then passed all nine focused
cases. They inject ENOSPC and EACCES during directory/configuration creation,
simultaneous setup/cleanup failures, failed configuration/directory removal and a
failed connection close. They check fixed errors, cleanup attempts and child exit.

PASS: all 106 tests across these four files, twice, with one worker:

- `apps/server/test/recovery-event-target.test.ts`
- `apps/server/test/recovery-restore.test.ts`
- `apps/server/test/object-restore.test.ts`
- `libs/event-store/test/event-restore.test.ts`

The runs took 285.94 and 322.72 seconds. Both used `nice -n 10` and the supplied
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`. These suites need no
PostgreSQL fixture. Safe logs are `/tmp/p5-8-pr3a-tests-1.log` and
`/tmp/p5-8-pr3a-tests-2.log`; the failing checks are recorded in
`/tmp/p5-8-pr3a-argv-red.log` and `/tmp/p5-8-pr3a-filesystem-red.log`.

PASS: full typecheck, `check:events` (155 types) and `lint:changelog`, all under
`nice -n 10`. The typecheck log is `/tmp/p5-8-pr3a-typecheck.log`.

The first full lint run found nine typing errors in the new tests. Test-only commit
`2ea45c191` checks that mocks returned before reading their results and requires
configuration text before reading the token. No assertion was removed. PASS: lint
for that final test file and all nine target tests twice again. Safe logs are
`/tmp/p5-8-pr3a-test-lint.log`, `/tmp/p5-8-pr3a-target-final-1.log` and
`/tmp/p5-8-pr3a-target-final-2.log`. PASS: server typecheck after that test-only
change, recorded in `/tmp/p5-8-pr3a-server-types-final.log`.

PASS: full lint after the test typing correction, including Knip, dependency checks,
documentation, links, fixtures, licences and changelog. ESLint reported zero errors
and 27 existing function-length warnings. Knip reported two configuration hints.
The full lint log is `/tmp/p5-8-pr3a-lint-final.log`. It ran under `nice -n 10`.

NOT RUN: full root suite and coordinated fresh-install/live recovery. The remaining
recovery conditions above stay unqualified. No access, money, memory or existing
assertion was weakened.
