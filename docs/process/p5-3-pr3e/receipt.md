# Backup storage confinement, first build

Date: 7 November 2026. Part of #15, P5-3 PR 3e.
Environment: this worktree, local test fixtures and one disposable MinIO container.
No development stack or fresh installation ran. The installer gate remains closed.

The accepted design uses short-lived credentials issued by the owned local MinIO
store. This first build adds a provisioner. It reads root credentials from the
owned stack directory, writes one fixed policy for `ocn-backup-<silo>/cnpg`, and
checks the signed policy, parent, access key and expiry in the returned STS token.
The policy allows object and version work only beneath `cnpg/`. Listing requires
that prefix. A process-local record binds the credential to the Namespace and
Service UIDs, endpoint, CA and destination. A changed credential or record refuses.
Renewal reuses the private bucket.
The helper also checks that the requested silo matches `SILO_ID` in the owned
stack's saved settings before asking MinIO for a credential. A valid name for
another silo now refuses.

The checker and Helm preview do not use the new record yet. The checker still
probes invented locations and refuses every result because it has no complete
inventory of other silos. This remains closed, even for a confined credential.
The next split must carry the STS session token through the preview and checker,
check the record before marker writes, and replace the invented probes and
inventory refusal. Marker cleanup, final Kubernetes reference checks, deadlines,
TLS checks and plain refusals remain as they were.

| Check | Observed result | Status |
| --- | --- | --- |
| Failing-first tests | Earlier identity cases and the new foreign-silo test failed before their fixes | PASS |
| Existing helper and chart tests | 210 tests passed twice | PASS |
| New identity tests | Eight tests, including foreign-silo refusal, passed twice | PASS |
| CI test grouping | The new identity test is in the CI Node test command; grouping check passed | PASS |
| Installer gate | 22 selected backup and recovery tests passed twice | PASS |
| Disposable pinned MinIO | Issuance, signed policy, own read/write/delete, foreign read/write and root-list denial, and renewal passed | PASS |
| Development-stack typecheck | Passed after fixing optional session-token typing | PASS |
| Full typecheck | Passed after the final source change | PASS |
| Event catalogue | 158 event types agree | PASS |
| Knip | Passed with two configuration hints | PASS |
| Changelog lint | Passed | PASS |
| Full lint | Passed with zero errors and 37 existing warnings | PASS |
| Root suite | Excluded from this task | NOT RUN |
| Fresh-install backup, WAL, restore and promotion | No stack or live journey ran | NOT RUN |

The MinIO container used the pinned local image and synthetic root credentials.
It was removed with its volume after the check. The local test fixture signed
synthetic STS replies. It refused an over-granted policy, a changed signed policy,
substituted credentials and records. These tests do not qualify the CNPG installer
or a live backup. P5-3 remains PARTIAL.
