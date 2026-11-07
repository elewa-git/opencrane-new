# Backup storage access check

Date: 7 November 2026. Part of #15, P5-3 PR 3e.
Rebased on `2659e880a`. The installer gate remains closed. P5-3 remains PARTIAL.

The check binds the requested storage path to the destination recorded on the owned
credential Secret. It creates, reads and removes a random marker with the referenced
identity, checked Service address and referenced CA. It then requires denied read,
list and conditional write requests outside the prefix and in another bucket.
Bucket-root listing must also be denied. A broader credential fails with a plain
reason. Missing objects or failed write conditions do not count as denied access.
These are checks at the chosen locations, not an inspection of every storage grant.

The check tests deletion before creating a marker. Once PUT may have reached storage,
cleanup runs even after cancellation, a lost reply or the original deadline. Cleanup
has its own one-second deadline. When a PUT reply is lost, HEAD finds the matching
object's version before removal. Conditional requests protect foreign or changed
objects. A failed removal returns a plain cleanup reason. A later outage or permission
change can prevent removal; the check then refuses rather than claiming cleanup.

Tests use generated local TLS certificates, signed HTTPS requests and synthetic
Kubernetes objects. They supply root and individual excessive-permission identities
against the same destination. The lost PUT reply, versioned lost reply, stalled GET
and denied DELETE cases assert zero remaining markers before teardown.
No development stack, real bucket, root suite or live journey ran.

| Check | Observed result | Status |
| --- | --- | --- |
| Failing-first cleanup | Four tests failed before implementation; committed at `461036924` | PASS |
| Failing-first confinement | Eight excessive-identity tests failed; committed at `6131ead7b` | PASS |
| Failing-first write-only grants | Two existing tests failed with S3 read-permission rules; committed at `9e0be40e2` | PASS |
| Failing-first destination binding | Two tests failed; committed at `741046b58` | PASS |
| Changed tests | 183 helper and 26 chart tests passed twice | PASS |
| Installer gate | 22 selected backup/recovery cases passed | PASS |
| Event catalogue | 158 event types agree | PASS |
| Full typecheck | Workspace, package and development-stack checks passed | PASS |
| Full lint, knip and changelog | All checks passed with the 6 GiB Node heap limit | PASS |
| Fresh-install backup, WAL, three-database restore and promotion | No live journey ran | NOT RUN |

Commands use `nice -n 10` and tests set
`PG_TEST_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
The changed tests run with Node's test runner and `--test-concurrency=1`:
`infra/dev-stack/cnpg-backup.test.ts` and `infra/package/chart.test.mjs`.
The gate tests select `backup|recovery` from `infra/package/preflight.test.mjs`
and `infra/package/cnpg-install.test.mjs`. These tests do not use PostgreSQL.
Required checks are `npm run lint`, `npm run typecheck`, `npm run check:events`,
knip through `npm run lint:unused`, and `npm run lint:changelog`.
The first lint attempt was stopped after slow progress near Node's default 4 GiB heap
limit. The rerun uses `NODE_OPTIONS=--max-old-space-size=6144` for that command only.
