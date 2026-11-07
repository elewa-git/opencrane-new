# Backup storage access check

Date: 7 November 2026. Part of #15, P5-3 PR 3e.
Source: `ad54f2fcc`, based on `2659e880a` from `origin/main`.
Environment: this worktree with disposable local HTTPS fixtures, not a fresh install.
The installer gate remains closed. P5-3 remains PARTIAL.

The installer reads one silo's values file. It has no trusted list of other silos'
backup buckets and prefixes. The helper now refuses to pass after its existing
checks, with `CNPG cannot enumerate other silos' backup locations`. A scoped-looking
identity also receives that refusal. Denied requests to invented names cannot
establish isolation, and the destination annotation cannot limit additional grants.

Before approval becomes possible, the installer must enumerate every other silo's
real storage locations from the same configuration it uses to install those silos.
Read, list and write must each be refused at those locations. The current S3 adapter
has no operation that reports the credential's effective policy. No policy inspection
or admin access is claimed. A supported non-admin policy report must also be compared
if one becomes available.

The existing marker and cleanup checks remain unchanged. Deletion permission is
checked before writing. Once PUT may have reached storage, cleanup gets a separate
one-second deadline, including after cancellation or a lost reply. Conditional
requests protect foreign or changed bytes; versioned cleanup removes the exact
stored version. An outage or permission change may still prevent removal, which
returns a cleanup refusal rather than a claim that no bytes remain.

The regression identity allows the usual destination, `database-backups/other-silo/`
and `other-silo-backups`. It denies root listing and invented locations. The unchanged
checker accepted it. The test requiring refusal failed, along with the ordinary
scoped-identity test, before the implementation changed. Both now pass and assert
that no marker remains. The earlier cleanup and access assertions are retained.

| Check | Observed result | Status |
| --- | --- | --- |
| Failing-first missing locations | Two expected rejection tests failed; committed first at `f0e733a04` | PASS |
| Changed helper and chart tests | 184 helper and 26 chart tests passed twice | PASS |
| Installer gate | 22 selected backup/recovery cases passed twice | PASS |
| Event catalogue | 158 event types agree | PASS |
| Full typecheck | Workspace, package and development-stack checks passed | PASS |
| Full lint, knip and changelog | All checks passed with the 6 GiB Node heap limit | PASS |
| Root suite | Excluded from this task | NOT RUN |
| Fresh-install backup, WAL, three-database restore and promotion | No stack or live journey ran | NOT RUN |

Tests use generated local TLS certificates, signed HTTPS requests and synthetic
Kubernetes objects. No real bucket, owner stack or secondary stack was contacted.
The [regression and cleanup tests](../../../infra/dev-stack/cnpg-backup.test.ts)
and [storage fixture](../../../infra/dev-stack/cnpg-backup-s3-fixture.ts) record the
identities, expected refusals and zero-marker assertions.

Commands use `nice -n 10`. Tests set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`; these selected tests
do not use PostgreSQL. Both runs use Node's test runner with
`--experimental-strip-types --test --test-concurrency=1`:

- `infra/dev-stack/cnpg-backup.test.ts infra/package/chart.test.mjs`.
- `--test-name-pattern='backup|recovery' infra/package/preflight.test.mjs infra/package/cnpg-install.test.mjs`.

Other checks: `npm run lint` with `NODE_OPTIONS=--max-old-space-size=6144`,
`npm run typecheck`, `npm run check:events`, knip through `npm run lint:unused`,
and `npm run lint:changelog`. The full lint command includes knip and changelog checks.
ESLint reports zero errors and 37 warnings. Knip reports two configuration hints.
