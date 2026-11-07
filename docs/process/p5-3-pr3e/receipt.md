# Backup storage access check

Date: 7 November 2026. Part of #15, P5-3 PR 3e.
Base: `b5a2a2ba1`. Failing-first test commit: `fa1daf7db`.

The internal check uses the installed MinIO client to create, read and remove one
random marker under the reviewed S3 destination. The checked Service address and
referenced CA and identity remain fixed through the check. Requests, cleanup and
final Kubernetes identity checks share the original deadline and cancellation.
Conditional creation and deletion protect existing or changed objects. If the store
returns a version id, the check reads and removes that exact version.
The installer gate remains closed. P5-3 remains PARTIAL.

The environment was this worktree with freshly generated local TLS certificates
and synthetic owned Kubernetes objects. No development stack or real bucket was
used. Each test closes its listener and removes remaining synthetic objects.
This proves local permission checking only. The marker is not a backup.
A denied DELETE or interrupted request can leave a marker. The check then refuses;
it never starts cleanup after cancellation or the deadline.

| Check | Expected and observed result | Status |
| --- | --- | --- |
| Setup | Updated from main, installed dependencies and linked the requested tools | PASS |
| Failing-first | The new permission test failed before implementation | PASS |
| Input race | Two tests failed before capturing the checked destination; both pass after the fix | PASS |
| Exact version cleanup | Failed first; now removes the stored version rather than hiding its bytes | PASS |
| Focused tests | 169 passed twice on the final code | PASS |
| Installer gate | 22 backup/recovery refusal cases passed | PASS |
| Event security | 460 tests passed; protected test files are unchanged | PASS |
| Types and catalogue | Root typecheck and check:events passed | PASS |
| Lint, knip and changelog | Full lint completed, including knip and changelog validation | PASS |
| Fresh-install backup, WAL, three-database restore and promotion | No live journey ran | NOT RUN |

Local commands use `nice -n 10`. Focused checks use Node's test runner for
`infra/dev-stack/cnpg-backup.test.ts`, plus the backup/recovery cases from
`infra/package/preflight.test.mjs` and `infra/package/cnpg-install.test.mjs`.
Security uses `npx vitest run libs/events/test/security-rules.test.ts --maxWorkers=2`
with the requested local `PG_TEST_URL`. No root suite ran locally.
GitHub CI on the pushed commit is reported separately in the final build report.
