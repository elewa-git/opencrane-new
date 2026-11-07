# Local backup credential record

Status: PARTIAL. Part of #15.

The checker now matches an issued record to the credential, owned resource UIDs,
endpoint, CA, destination and Secret generation before marker PUT. It retains
conditional writes, cleanup, TLS and deadlines. Preflight blocks installation.

- PASS: 217 checker and identity tests on each of two runs. Each of the three
  focused tests fails when its guard is removed. Typecheck, event catalogue,
  knip, changelog and Markdown checks pass.
- PARTIAL: Scoped ESLint ignores both changed test files under the repository
  configuration.
- NOT RUN: Root suite, dev stack, real MinIO, renewal, WAL, restore, promotion.
