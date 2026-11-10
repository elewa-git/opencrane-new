# Local backup lease renewal

Status: PARTIAL. Part of #15.

The local helper closes the earlier credential record before renewal begins. A
replacement must have a new signed token and Secret generation for the same owned
storage. A failed, cancelled or late renewal leaves the earlier record closed.
The installer still blocks backup and recovery settings.

- PASS: Both final runs of the focused test files passed, 233 tests each. The two
  failing-first cases cover revocation and expiry during the last Namespace read.
  Each renewal target case starts with a fresh record. Typecheck, event catalogue,
  knip, changelog and Markdown checks passed.
- PARTIAL: Scoped ESLint exited without errors but ignored the changed infra
  files under the repository configuration.
- NOT RUN: Live MinIO issuance and enforcement, scheduled base backup and WAL,
  three-database restore and standby promotion. These need a reviewed fresh install.
