# Local backup credential record

Status: PARTIAL. Part of #15.

The checker now matches an issued record to the credential, owned resource UIDs,
endpoint, CA, destination and Secret generation before marker PUT. It retains
conditional writes, cleanup, TLS and deadlines. Preflight blocks installation.

- PASS: Failing-first test; focused tests twice; event security rules; typecheck;
  event catalogue; knip; changelog, README, Markdown and process text checks.
- PARTIAL: Scoped ESLint ignored infra files under repository configuration.
- NOT RUN: Root suite, dev stack, real MinIO, renewal, WAL, restore, promotion.
